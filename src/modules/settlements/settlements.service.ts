import { Injectable, Logger } from "@nestjs/common";
import { PaymentMode, PaymentStatus, Prisma, SettlementStatus } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import { LEDGER_ACCOUNTS } from "@/config/app.constants";
import { SYSTEM_ROLES } from "@/common/rbac/permissions";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type {
  GenerateSettlementDto,
  PayoutSettlementDto,
  RejectSettlementDto,
  RevenueQueryDto,
  SettlementQueryDto,
} from "./dto/settlement.dto";

type Ctx = { ip?: string; requestId?: string };

const SORTABLE = ["periodStart", "periodEnd", "createdAt", "grossCollected", "status"] as const;

/** Payments that represent money actually received. */
const CAPTURED: PaymentStatus[] = [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED];

const SETTLEMENT_SELECT = {
  id: true,
  vendorId: true,
  periodStart: true,
  periodEnd: true,
  grossCollected: true,
  cashCollected: true,
  digitalCollected: true,
  commissionAmount: true,
  vendorShare: true,
  governmentShare: true,
  status: true,
  approvedBy: true,
  approvedAt: true,
  rejectionReason: true,
  payoutRef: true,
  payoutStatus: true,
  createdAt: true,
  vendor: { select: { id: true, orgName: true, commissionPct: true, bankAccountNo: true, bankIfsc: true } },
  _count: { select: { lines: true } },
} satisfies Prisma.SettlementSelect;

/**
 * Settlement: working out what each vendor is owed, and recording it so it
 * balances.
 *
 * The shape of the arithmetic is fixed and deliberately dull. Every captured
 * payment in the period belongs to exactly one settlement — enforced by a
 * unique constraint on (settlement, payment) rather than by care — so running
 * generation twice cannot pay a vendor twice for the same parking session.
 *
 * Amounts are net of refunds throughout. Money handed back was never revenue,
 * and a vendor should not earn commission on it.
 */
@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private scopeFilter(user: AuthenticatedUser): Prisma.SettlementWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) return { vendorId: user.vendorId };
    return {};
  }

  private reference(settlement: { id: string; periodStart: Date }): string {
    const period = settlement.periodStart.toISOString().slice(0, 7).replace("-", "");
    return `STL-${period}-${settlement.id.slice(-4).toUpperCase()}`;
  }

  async list(query: SettlementQueryDto, user: AuthenticatedUser) {
    const where: Prisma.SettlementWhereInput = {
      ...this.scopeFilter(user),
      ...(query.status ? { status: query.status } : {}),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.from || query.to
        ? {
            periodStart: { ...(query.from ? { gte: query.from } : {}) },
            periodEnd: { ...(query.to ? { lte: query.to } : {}) },
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.settlement.findMany({
        where,
        select: SETTLEMENT_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { periodStart: "desc" }),
        ...skipTake(query),
      }),
      this.prisma.settlement.count({ where }),
    ]);

    return new Paginated(
      items.map((s) => ({ ...s, reference: this.reference(s), sessionsCount: s._count.lines })),
      query.page,
      query.pageSize,
      total,
    );
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const settlement = await this.prisma.settlement.findFirst({
      where: { id, ...this.scopeFilter(user) },
      select: SETTLEMENT_SELECT,
    });
    if (!settlement) throw AppException.notFound("settlement");

    const lines = await this.prisma.settlementLine.findMany({
      where: { settlementId: id },
      select: {
        id: true,
        amount: true,
        commission: true,
        payment: {
          select: {
            id: true,
            mode: true,
            paidAt: true,
            session: { select: { id: true, code: true, plateNumber: true } },
          },
        },
      },
      orderBy: { payment: { paidAt: "asc" } },
    });

    const ledger = await this.prisma.ledgerEntry.findMany({
      where: { settlementId: id },
      orderBy: { postedAt: "asc" },
    });

    return {
      ...settlement,
      reference: this.reference(settlement),
      sessionsCount: settlement._count.lines,
      lines,
      ledger,
    };
  }

  /**
   * Build a draft settlement for one vendor over one period.
   *
   * Only payments not already attached to a settlement are swept in, so a
   * period re-run after a late-arriving webhook picks up the stragglers instead
   * of double-counting everything that was already banked.
   */
  async generate(dto: GenerateSettlementDto, user: AuthenticatedUser, ctx: Ctx) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: dto.vendorId },
      select: { id: true, orgName: true, commissionPct: true },
    });
    if (!vendor) throw AppException.notFound("vendor");

    const existing = await this.prisma.settlement.findUnique({
      where: {
        vendorId_periodStart_periodEnd: {
          vendorId: dto.vendorId,
          periodStart: dto.periodStart,
          periodEnd: dto.periodEnd,
        },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      throw new AppException(
        "DUPLICATE_RESOURCE",
        [{ field: "periodStart", issue: "a settlement already covers this period" }],
        `${vendor.orgName} already has a settlement for this period. Open it rather than generating another.`,
      );
    }

    const payments = await this.prisma.payment.findMany({
      where: {
        status: { in: CAPTURED },
        paidAt: { gte: dto.periodStart, lte: dto.periodEnd },
        session: { vendorId: dto.vendorId },
        // The join row is the record of "already settled". Its unique
        // constraint on (settlementId, paymentId) is what actually prevents
        // double payment; this filter just keeps the draft clean.
        settlementLines: { none: {} },
      },
      select: { id: true, amount: true, refundedAmount: true, mode: true },
    });

    if (payments.length === 0) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "periodStart", issue: "no unsettled payments in this period" }],
        `There is nothing to settle for ${vendor.orgName} in that period.`,
      );
    }

    const commissionPct = Number(vendor.commissionPct);
    let gross = 0;
    let cash = 0;
    let digital = 0;
    let commissionTotal = 0;

    const lines = payments.map((payment) => {
      // Net of refunds: money handed back was never revenue, and no commission
      // is earned on it.
      const amount = payment.amount - payment.refundedAmount;
      const commission = Math.round((amount * commissionPct) / 100);

      gross += amount;
      if (payment.mode === PaymentMode.CASH) cash += amount;
      else digital += amount;
      commissionTotal += commission;

      return { paymentId: payment.id, amount, commission };
    });

    // The vendor earns their commission; everything else is the authority's.
    // Derived by subtraction rather than a second percentage, so the two halves
    // always add back to gross however the rounding fell on each line.
    const vendorShare = commissionTotal;
    const governmentShare = gross - commissionTotal;

    const settlement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.settlement.create({
        data: {
          vendorId: dto.vendorId,
          periodStart: dto.periodStart,
          periodEnd: dto.periodEnd,
          grossCollected: gross,
          cashCollected: cash,
          digitalCollected: digital,
          commissionAmount: commissionTotal,
          vendorShare,
          governmentShare,
          status: SettlementStatus.DRAFT,
        },
        select: SETTLEMENT_SELECT,
      });

      await tx.settlementLine.createMany({
        data: lines.map((line) => ({ ...line, settlementId: created.id })),
      });

      return created;
    });

    await this.audit.record({
      actor: user,
      action: "SETTLEMENT_GENERATE",
      entity: "Settlement",
      entityId: settlement.id,
      after: {
        vendor: vendor.orgName,
        payments: lines.length,
        gross,
        vendorShare,
        governmentShare,
      },
      ...ctx,
    });

    return this.findOne(settlement.id, user);
  }

  /** A draft goes up for approval. Nothing else about it may change after this. */
  async submit(id: string, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.require(id, user, [SettlementStatus.DRAFT]);

    await this.prisma.settlement.update({
      where: { id },
      data: { status: SettlementStatus.PENDING_APPROVAL },
    });

    await this.audit.record({
      actor: user,
      action: "SETTLEMENT_SUBMIT",
      entity: "Settlement",
      entityId: id,
      before: { status: current.status },
      after: { status: SettlementStatus.PENDING_APPROVAL },
      ...ctx,
    });

    return this.findOne(id, user);
  }

  /**
   * Approve, and post the settlement to the ledger.
   *
   * The postings are what make this auditable: gross came in as cash and as
   * gateway receipts, and goes out as a payable to the vendor and revenue to
   * the authority. Debits and credits are equal by construction, and the
   * assertion below refuses to write them if they ever stop being.
   */
  async approve(id: string, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.require(id, user, [SettlementStatus.PENDING_APPROVAL]);

    const entries = [
      { account: LEDGER_ACCOUNTS.CASH_IN_HAND, debit: current.cashCollected, credit: 0 },
      { account: LEDGER_ACCOUNTS.GATEWAY_RECEIVABLE, debit: current.digitalCollected, credit: 0 },
      { account: LEDGER_ACCOUNTS.VENDOR_PAYABLE, debit: 0, credit: current.vendorShare },
      { account: LEDGER_ACCOUNTS.GOVERNMENT_REVENUE, debit: 0, credit: current.governmentShare },
    ].filter((entry) => entry.debit > 0 || entry.credit > 0);

    this.assertBalanced(entries, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.settlement.update({
        where: { id },
        data: {
          status: SettlementStatus.APPROVED,
          approvedBy: user.id,
          approvedAt: new Date(),
          rejectionReason: null,
        },
      });

      await tx.ledgerEntry.createMany({
        data: entries.map((entry) => ({
          ...entry,
          settlementId: id,
          refType: "Settlement",
          refId: id,
        })),
      });
    });

    await this.audit.record({
      actor: user,
      action: "SETTLEMENT_APPROVE",
      entity: "Settlement",
      entityId: id,
      before: { status: current.status },
      after: { status: SettlementStatus.APPROVED, posted: entries.length },
      ...ctx,
    });

    return this.findOne(id, user);
  }

  async reject(id: string, dto: RejectSettlementDto, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.require(id, user, [SettlementStatus.PENDING_APPROVAL]);

    await this.prisma.settlement.update({
      where: { id },
      data: { status: SettlementStatus.REJECTED, rejectionReason: dto.reason },
    });

    await this.audit.record({
      actor: user,
      action: "SETTLEMENT_REJECT",
      entity: "Settlement",
      entityId: id,
      before: { status: current.status },
      after: { status: SettlementStatus.REJECTED, reason: dto.reason },
      ...ctx,
    });

    return this.findOne(id, user);
  }

  /**
   * Record that the vendor has been paid.
   *
   * This does not move money. RazorpayX credentials do not exist yet, so the
   * transfer is made at the bank and its reference recorded here — which is
   * also the fallback the authority will want on the day the gateway is down.
   * When those keys arrive, an automated payout should call this same method
   * with the payout id it gets back, so the ledger half stays in one place.
   */
  async payout(id: string, dto: PayoutSettlementDto, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.require(id, user, [SettlementStatus.APPROVED]);

    if (current.vendorShare <= 0) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "vendorShare", issue: "nothing is payable" }],
        "This settlement owes the vendor nothing, so there is no payout to record.",
      );
    }

    const entries = [
      { account: LEDGER_ACCOUNTS.VENDOR_PAYABLE, debit: current.vendorShare, credit: 0 },
      { account: LEDGER_ACCOUNTS.CASH_IN_HAND, debit: 0, credit: current.vendorShare },
    ];
    this.assertBalanced(entries, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.settlement.update({
        where: { id },
        data: {
          status: SettlementStatus.PAID,
          payoutRef: dto.reference,
          // Recorded manually until RazorpayX credentials exist. The distinction
          // matters to whoever reconciles the bank statement.
          payoutStatus: "MANUAL",
        },
      });

      await tx.ledgerEntry.createMany({
        data: entries.map((entry) => ({
          ...entry,
          settlementId: id,
          refType: "Payout",
          refId: dto.reference,
        })),
      });
    });

    await this.audit.record({
      actor: user,
      action: "SETTLEMENT_PAYOUT",
      entity: "Settlement",
      entityId: id,
      before: { status: current.status },
      after: { status: SettlementStatus.PAID, reference: dto.reference, note: dto.note },
      ...ctx,
    });

    return this.findOne(id, user);
  }

  async summary(user: AuthenticatedUser) {
    const scope = this.scopeFilter(user);
    const [byStatus, totals] = await Promise.all([
      this.prisma.settlement.groupBy({
        by: ["status"],
        where: scope,
        _count: { _all: true },
        _sum: { vendorShare: true },
      }),
      this.prisma.settlement.aggregate({
        where: scope,
        _sum: { grossCollected: true, vendorShare: true, governmentShare: true, commissionAmount: true },
      }),
    ]);

    const row = (status: SettlementStatus) => byStatus.find((s) => s.status === status);

    return {
      gross: totals._sum.grossCollected ?? 0,
      vendorShare: totals._sum.vendorShare ?? 0,
      governmentShare: totals._sum.governmentShare ?? 0,
      commission: totals._sum.commissionAmount ?? 0,
      counts: {
        draft: row(SettlementStatus.DRAFT)?._count._all ?? 0,
        pendingApproval: row(SettlementStatus.PENDING_APPROVAL)?._count._all ?? 0,
        approved: row(SettlementStatus.APPROVED)?._count._all ?? 0,
        rejected: row(SettlementStatus.REJECTED)?._count._all ?? 0,
        paid: row(SettlementStatus.PAID)?._count._all ?? 0,
      },
      /** Approved but not yet transferred — what the authority still owes. */
      awaitingPayout: row(SettlementStatus.APPROVED)?._sum.vendorShare ?? 0,
    };
  }

  /**
   * Revenue, from the payments themselves rather than from settlements.
   *
   * Deliberately not derived from settlement rows: money collected yesterday is
   * revenue today, whether or not anyone has run a settlement for it. Reading
   * this from settlements would make the revenue screen a report on
   * administrative diligence instead of on takings.
   */
  async revenue(query: RevenueQueryDto, user: AuthenticatedUser) {
    const where: Prisma.PaymentWhereInput = {
      status: { in: CAPTURED },
      ...(query.from || query.to
        ? { paidAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(user.role === SYSTEM_ROLES.VENDOR && user.vendorId
        ? { session: { vendorId: user.vendorId } }
        : query.vendorId
          ? { session: { vendorId: query.vendorId } }
          : {}),
    };

    const [byMode, totals, payments] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ["mode"],
        where,
        _sum: { amount: true, refundedAmount: true },
        _count: { _all: true },
      }),
      this.prisma.payment.aggregate({
        where,
        _sum: { amount: true, refundedAmount: true },
        _count: { _all: true },
      }),
      this.prisma.payment.findMany({
        where,
        select: {
          amount: true,
          refundedAmount: true,
          paidAt: true,
          session: { select: { zoneId: true, vendorId: true } },
        },
      }),
    ]);

    // Grouping by day and by zone in the database would need raw SQL for the
    // date truncation; the row count here is one period of payments, which is
    // small enough to fold in memory and keeps this portable.
    const byDay = new Map<string, number>();
    const byZone = new Map<string, number>();
    const byVendor = new Map<string, number>();

    for (const payment of payments) {
      const net = payment.amount - payment.refundedAmount;
      const day = (payment.paidAt ?? new Date()).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + net);
      if (payment.session) {
        byZone.set(payment.session.zoneId, (byZone.get(payment.session.zoneId) ?? 0) + net);
        byVendor.set(payment.session.vendorId, (byVendor.get(payment.session.vendorId) ?? 0) + net);
      }
    }

    const [zones, vendors] = await Promise.all([
      byZone.size
        ? this.prisma.zone.findMany({
            where: { id: { in: [...byZone.keys()] } },
            select: {
              id: true,
              code: true,
              name: true,
              ward: { select: { name: true } },
              // A zone is operated by at most one vendor in practice, but the
              // join allows several; the screen names the first.
              vendorZones: { select: { vendor: { select: { orgName: true } } }, take: 1 },
            },
          })
        : Promise.resolve([]),
      byVendor.size
        ? this.prisma.vendor.findMany({
            where: { id: { in: [...byVendor.keys()] } },
            select: {
              id: true,
              orgName: true,
              commissionPct: true,
              _count: { select: { zones: true, attendants: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const gross = totals._sum.amount ?? 0;
    const refunded = totals._sum.refundedAmount ?? 0;

    return {
      gross,
      refunded,
      net: gross - refunded,
      count: totals._count._all,
      byMode: byMode.map((m) => ({
        mode: m.mode,
        amount: (m._sum.amount ?? 0) - (m._sum.refundedAmount ?? 0),
        count: m._count._all,
      })),
      byDay: [...byDay.entries()]
        .map(([date, amount]) => ({ date, amount }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      byZone: zones
        .map((zone) => ({
          id: zone.id,
          code: zone.code,
          name: zone.name,
          wardName: zone.ward?.name ?? null,
          vendorName: zone.vendorZones[0]?.vendor.orgName ?? null,
          amount: byZone.get(zone.id) ?? 0,
        }))
        .sort((a, b) => b.amount - a.amount),
      byVendor: vendors
        .map((vendor) => {
          const amount = byVendor.get(vendor.id) ?? 0;
          const commission = Math.round((amount * Number(vendor.commissionPct)) / 100);
          return {
            id: vendor.id,
            orgName: vendor.orgName,
            commissionPct: Number(vendor.commissionPct),
            zoneCount: vendor._count.zones,
            attendantCount: vendor._count.attendants,
            amount,
            commission,
            governmentShare: amount - commission,
          };
        })
        .sort((a, b) => b.amount - a.amount),
    };
  }

  private async require(id: string, user: AuthenticatedUser, allowed: SettlementStatus[]) {
    const settlement = await this.prisma.settlement.findFirst({
      where: { id, ...this.scopeFilter(user) },
      select: SETTLEMENT_SELECT,
    });
    if (!settlement) throw AppException.notFound("settlement");

    if (!allowed.includes(settlement.status)) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "status", issue: `settlement is ${settlement.status.toLowerCase()}` }],
        `${this.reference(settlement)} is ${settlement.status.toLowerCase().replace(/_/g, " ")}, so that step does not apply to it.`,
      );
    }
    return settlement;
  }

  /**
   * Refuses to post entries that do not balance.
   *
   * If this ever throws it is a bug in the arithmetic above, not bad input —
   * but an unbalanced ledger discovered by an auditor months later is far more
   * expensive than a failed request now.
   */
  private assertBalanced(entries: { debit: number; credit: number }[], id: string): void {
    const debits = entries.reduce((s, e) => s + e.debit, 0);
    const credits = entries.reduce((s, e) => s + e.credit, 0);
    if (debits !== credits) {
      this.logger.error(`Refusing to post unbalanced ledger for settlement ${id}: ${debits} ≠ ${credits}`);
      throw new AppException(
        "INTERNAL_ERROR",
        undefined,
        "This settlement does not balance and has not been posted. Please report it.",
      );
    }
  }
}
