import { Injectable } from "@nestjs/common";
import { SYSTEM_ROLES, type RoleCode } from "@/common/rbac/permissions";
import {
  PaymentStatus,
  Prisma,
  SessionStatus,
  SettlementStatus,
  UserStatus,
  VendorStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { applyPercent } from "@/common/utils/money.util";
import type {
  AddDocumentDto,
  AssignZonesDto,
  CommissionDto,
  CreateVendorDto,
  UpdateVendorDto,
  VendorQueryDto,
  VendorStatusDto,
} from "./dto/vendor.dto";

const SORTABLE = ["orgName", "createdAt", "commissionPct", "status"] as const;

/** The documents a vendor must have verified before money can leave the building. */
const REQUIRED_DOCS = ["AGREEMENT", "GST", "PAN", "BANK_PROOF"] as const;

const VENDOR_SELECT = {
  id: true,
  orgName: true,
  contactName: true,
  contactPhone: true,
  gstin: true,
  pan: true,
  bankAccountName: true,
  bankAccountNo: true,
  bankIfsc: true,
  commissionPct: true,
  rating: true,
  status: true,
  approvedAt: true,
  createdAt: true,
  user: { select: { id: true, email: true, status: true, lastLoginAt: true } },
  documents: {
    select: { id: true, type: true, mediaId: true, verifiedBy: true, verifiedAt: true, createdAt: true },
  },
  _count: { select: { zones: true, attendants: true } },
} satisfies Prisma.VendorSelect;

@Injectable()
export class VendorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** A vendor may only ever see itself. */
  private scope(user: AuthenticatedUser): Prisma.VendorWhereInput {
    return user.role === SYSTEM_ROLES.VENDOR && user.vendorId ? { id: user.vendorId } : {};
  }

  /** Bank details are masked for everyone except the vendor itself and finance roles. */
  private maskBank<T extends { bankAccountNo?: string | null }>(
    vendor: T,
    user: AuthenticatedUser,
  ): T {
    const privileged =
      user.role === SYSTEM_ROLES.SUPER_ADMIN ||
      user.role === SYSTEM_ROLES.ADMIN ||
      (user.role === SYSTEM_ROLES.VENDOR && "id" in vendor && user.vendorId === (vendor as { id: string }).id);
    if (privileged || !vendor.bankAccountNo) return vendor;
    return { ...vendor, bankAccountNo: `•••• ${vendor.bankAccountNo.slice(-4)}` };
  }

  private kycState(documents: { type: string; verifiedAt: Date | null }[]) {
    const verified = new Set(documents.filter((d) => d.verifiedAt).map((d) => d.type));
    const missing = REQUIRED_DOCS.filter((t) => !verified.has(t));
    return { kycComplete: missing.length === 0, missingDocuments: missing };
  }

  async list(query: VendorQueryDto, user: AuthenticatedUser) {
    const where: Prisma.VendorWhereInput = {
      ...this.scope(user),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { orgName: { contains: query.q, mode: "insensitive" } },
              { contactName: { contains: query.q, mode: "insensitive" } },
              { contactPhone: { contains: query.q } },
              { user: { email: { contains: query.q, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.vendor.findMany({
        where,
        select: VENDOR_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { orgName: "asc" }),
        ...skipTake(query),
      }),
      this.prisma.vendor.count({ where }),
    ]);

    const items = rows
      .map((v) => ({ ...this.maskBank(v, user), ...this.kycState(v.documents) }))
      .filter((v) => query.kycComplete === undefined || v.kycComplete === query.kycComplete);

    return new Paginated(items, query.page, query.pageSize, total);
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const vendor = await this.prisma.vendor.findFirst({
      where: { id, ...this.scope(user) },
      select: {
        ...VENDOR_SELECT,
        zones: {
          where: { endedAt: null },
          select: {
            assignedAt: true,
            zone: { select: { id: true, code: true, name: true, capacity: true, status: true } },
          },
        },
      },
    });
    if (!vendor) throw AppException.notFound("vendor");

    return { ...this.maskBank(vendor, user), ...this.kycState(vendor.documents) };
  }

  async create(dto: CreateVendorDto, actor: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (existing) {
      throw new AppException("DUPLICATE_RESOURCE", [{ field: "email", issue: "already registered" }]);
    }

    // The vendor's portal login and their organisation record are created
    // together — a vendor without a way to sign in is not a usable record.
    const vendor = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.contactName,
          email: dto.email.toLowerCase(),
          phone: dto.contactPhone,
          role: SYSTEM_ROLES.VENDOR,
          status: UserStatus.ACTIVE,
          passwordHash: dto.password ? await bcrypt.hash(dto.password, 12) : null,
        },
      });

      return tx.vendor.create({
        data: {
          userId: user.id,
          orgName: dto.orgName,
          contactName: dto.contactName,
          contactPhone: dto.contactPhone,
          gstin: dto.gstin,
          pan: dto.pan,
          bankAccountName: dto.bankAccountName,
          bankAccountNo: dto.bankAccountNo,
          bankIfsc: dto.bankIfsc,
          commissionPct: new Prisma.Decimal(dto.commissionPct),
          status: VendorStatus.PENDING,
        },
        select: VENDOR_SELECT,
      });
    });

    await this.audit.record({
      actor,
      action: "VENDOR_CREATE",
      entity: "Vendor",
      entityId: vendor.id,
      after: { orgName: vendor.orgName, status: vendor.status, commissionPct: dto.commissionPct },
      ...ctx,
    });

    return { ...vendor, ...this.kycState(vendor.documents) };
  }

  async update(
    id: string,
    dto: UpdateVendorDto,
    actor: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const before = await this.prisma.vendor.findUnique({ where: { id }, select: VENDOR_SELECT });
    if (!before) throw AppException.notFound("vendor");

    const { email, commissionPct, ...rest } = dto;
    const after = await this.prisma.$transaction(async (tx) => {
      if (email) {
        await tx.user.update({
          where: { id: before.user.id },
          data: { email: email.toLowerCase() },
        });
      }
      return tx.vendor.update({
        where: { id },
        data: {
          ...rest,
          ...(commissionPct !== undefined
            ? { commissionPct: new Prisma.Decimal(commissionPct) }
            : {}),
        },
        select: VENDOR_SELECT,
      });
    });

    await this.audit.record({
      actor,
      action: "VENDOR_UPDATE",
      entity: "Vendor",
      entityId: id,
      before,
      after,
      ...ctx,
    });

    return { ...after, ...this.kycState(after.documents) };
  }

  /**
   * Whether an officer may approve a vendor whose documents are not yet in the
   * platform. Defaults to refusing, which is the safe reading.
   *
   * It has to be a decision the authority can make, because otherwise the very
   * first vendor can never be onboarded: approval needs verified documents,
   * documents need an upload, and an upload needs object storage that a fresh
   * deployment does not yet have. A municipal body also verifies papers in a
   * folder long before they are scanned, and refusing to record a decision that
   * has genuinely been taken does not make the platform safer — it makes it
   * bypassed.
   *
   * When it is turned off, the approval still goes through the audit trail with
   * the missing documents named, so the fact that it was granted on paper is
   * itself a matter of record.
   */
  private async requireKycForApproval(): Promise<boolean> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: "vendor.requireKycForApproval" },
    });
    return row?.value !== false;
  }

  /**
   * Approval is gated on verified KYC unless the authority has said otherwise.
   * A payout to an unverified account fails at the bank anyway — better to
   * refuse here, where the reason is legible.
   */
  async changeStatus(
    id: string,
    dto: VendorStatusDto,
    actor: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id },
      include: { documents: true },
    });
    if (!vendor) throw AppException.notFound("vendor");

    const { kycComplete, missingDocuments } = this.kycState(vendor.documents);

    const kycRequired = await this.requireKycForApproval();
    const approvedWithoutKyc =
      dto.status === VendorStatus.APPROVED && !kycComplete && !kycRequired;

    if (dto.status === VendorStatus.APPROVED && !kycComplete && kycRequired) {
      throw new AppException(
        "KYC_INCOMPLETE",
        missingDocuments.map((d) => ({ field: d, issue: "not verified" })),
        `Verify the vendor's ${missingDocuments.join(", ")} before approving them. ` +
          "An authority that verifies documents outside the platform can turn " +
          "off vendor.requireKycForApproval in system configuration.",
      );
    }

    const outstanding =
      dto.status === VendorStatus.BLOCKED
        ? await this.prisma.settlement.aggregate({
            where: { vendorId: id, status: { in: [SettlementStatus.APPROVED, SettlementStatus.PENDING_APPROVAL] } },
            _sum: { vendorShare: true },
          })
        : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const v = await tx.vendor.update({
        where: { id },
        data: {
          status: dto.status,
          approvedAt: dto.status === VendorStatus.APPROVED ? new Date() : vendor.approvedAt,
        },
        select: VENDOR_SELECT,
      });

      // Blocking ends the contract: release the kerb and stop the logins.
      if (dto.status === VendorStatus.BLOCKED) {
        await tx.vendorZone.updateMany({
          where: { vendorId: id, endedAt: null },
          data: { endedAt: new Date() },
        });
        await tx.attendant.updateMany({ where: { vendorId: id }, data: { isActive: false } });
        await tx.user.update({ where: { id: vendor.userId }, data: { status: UserStatus.SUSPENDED } });
      }

      if (dto.status === VendorStatus.SUSPENDED) {
        await tx.user.update({ where: { id: vendor.userId }, data: { status: UserStatus.SUSPENDED } });
      }

      if (dto.status === VendorStatus.APPROVED) {
        await tx.user.update({ where: { id: vendor.userId }, data: { status: UserStatus.ACTIVE } });
      }

      return v;
    });

    await this.audit.record({
      actor,
      action: `VENDOR_${dto.status}`,
      entity: "Vendor",
      entityId: id,
      before: { status: vendor.status },
      after: {
        status: dto.status,
        reason: dto.reason,
        // Recorded on the row itself, so an approval granted against documents
        // held outside the platform is legible in the trail rather than
        // indistinguishable from one granted against verified uploads.
        ...(approvedWithoutKyc
          ? { kycVerifiedOutsideThePlatform: true, documentsNotOnFile: missingDocuments }
          : {}),
      },
      ...ctx,
    });

    return {
      ...updated,
      ...this.kycState(updated.documents),
      outstandingPayout: outstanding?._sum.vendorShare ?? 0,
    };
  }

  // ------------------------------------------------------------------- KYC

  async addDocument(
    id: string,
    dto: AddDocumentDto,
    actor: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id }, select: { id: true } });
    if (!vendor) throw AppException.notFound("vendor");

    const doc = await this.prisma.vendorDocument.create({
      data: { vendorId: id, type: dto.type, mediaId: dto.mediaId },
    });

    await this.audit.record({
      actor,
      action: "VENDOR_DOCUMENT_ADD",
      entity: "VendorDocument",
      entityId: doc.id,
      after: { vendorId: id, type: dto.type },
      ...ctx,
    });

    return doc;
  }

  async verifyDocument(
    documentId: string,
    verified: boolean,
    actor: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const doc = await this.prisma.vendorDocument.update({
      where: { id: documentId },
      data: {
        verifiedBy: verified ? actor.id : null,
        verifiedAt: verified ? new Date() : null,
      },
    });

    await this.audit.record({
      actor,
      action: verified ? "VENDOR_DOCUMENT_VERIFY" : "VENDOR_DOCUMENT_REJECT",
      entity: "VendorDocument",
      entityId: documentId,
      after: { verified, type: doc.type },
      ...ctx,
    });

    return doc;
  }

  // ----------------------------------------------------------------- zones

  async assignZones(
    id: string,
    dto: AssignZonesDto,
    actor: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id } });
    if (!vendor) throw AppException.notFound("vendor");
    if (vendor.status !== VendorStatus.APPROVED) {
      throw AppException.forbidden("Only approved vendors can be assigned kerb.");
    }

    await this.prisma.$transaction(async (tx) => {
      if (dto.replace) {
        await tx.vendorZone.updateMany({
          where: { vendorId: id, endedAt: null, zoneId: { notIn: dto.zoneIds } },
          data: { endedAt: new Date() },
        });
      }
      // A zone belongs to one vendor at a time — end any other live assignment.
      await tx.vendorZone.updateMany({
        where: { zoneId: { in: dto.zoneIds }, endedAt: null, vendorId: { not: id } },
        data: { endedAt: new Date() },
      });
      for (const zoneId of dto.zoneIds) {
        await tx.vendorZone.upsert({
          where: { vendorId_zoneId: { vendorId: id, zoneId } },
          create: { vendorId: id, zoneId },
          update: { endedAt: null, assignedAt: new Date() },
        });
      }
    });

    await this.audit.record({
      actor,
      action: "VENDOR_ZONES_ASSIGN",
      entity: "Vendor",
      entityId: id,
      after: { zoneIds: dto.zoneIds, replace: dto.replace },
      ...ctx,
    });

    return this.findOne(id, actor);
  }

  async setCommission(
    id: string,
    dto: CommissionDto,
    actor: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const before = await this.prisma.vendor.findUnique({
      where: { id },
      select: { commissionPct: true, orgName: true },
    });
    if (!before) throw AppException.notFound("vendor");

    const vendor = await this.prisma.vendor.update({
      where: { id },
      data: { commissionPct: new Prisma.Decimal(dto.commissionPct) },
      select: VENDOR_SELECT,
    });

    await this.audit.record({
      actor,
      action: "VENDOR_COMMISSION_CHANGE",
      entity: "Vendor",
      entityId: id,
      before: { commissionPct: Number(before.commissionPct) },
      after: { commissionPct: dto.commissionPct, reason: dto.reason },
      ...ctx,
    });

    // Existing settlements keep the rate they were computed at; this applies
    // from the next cycle.
    return { ...vendor, appliesFrom: "next settlement cycle" };
  }

  // ----------------------------------------------------------- performance

  async performance(id: string, user: AuthenticatedUser) {
    const vendor = await this.prisma.vendor.findFirst({
      where: { id, ...this.scope(user) },
      select: { id: true, orgName: true, commissionPct: true, rating: true },
    });
    if (!vendor) throw AppException.notFound("vendor");

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [sessions, collected, pending, zones, attendants, variance] = await Promise.all([
      this.prisma.parkingSession.count({ where: { vendorId: id, startAt: { gte: monthStart } } }),
      this.prisma.payment.aggregate({
        where: {
          status: PaymentStatus.CAPTURED,
          paidAt: { gte: monthStart },
          session: { vendorId: id },
        },
        _sum: { amount: true },
      }),
      this.prisma.settlement.aggregate({
        where: { vendorId: id, status: { in: [SettlementStatus.PENDING_APPROVAL, SettlementStatus.APPROVED] } },
        _sum: { vendorShare: true },
      }),
      this.prisma.vendorZone.count({ where: { vendorId: id, endedAt: null } }),
      this.prisma.attendant.count({ where: { vendorId: id, isActive: true } }),
      this.prisma.shift.count({ where: { vendorId: id, status: "VARIANCE_FLAGGED" } }),
    ]);

    const gross = collected._sum.amount ?? 0;
    const commission = applyPercent(gross, Number(vendor.commissionPct));

    return {
      vendor,
      periodStart: monthStart.toISOString(),
      sessionsThisMonth: sessions,
      grossCollected: gross,
      governmentShare: commission,
      vendorShare: gross - commission,
      pendingPayout: pending._sum.vendorShare ?? 0,
      zonesOperated: zones,
      activeAttendants: attendants,
      /** Repeated variance is what a fraud review actually looks for. */
      shiftsWithCashVariance: variance,
    };
  }

  /** Single call that backs the vendor app's home screen. */
  async dashboard(user: AuthenticatedUser) {
    if (!user.vendorId) throw AppException.forbidden("This account is not linked to a vendor.");

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);

    const [active, todaySessions, todayCash, todayDigital, pending, openShifts] = await Promise.all([
      this.prisma.parkingSession.count({
        where: { vendorId: user.vendorId, status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] } },
      }),
      this.prisma.parkingSession.count({
        where: { vendorId: user.vendorId, startAt: { gte: dayStart } },
      }),
      this.prisma.payment.aggregate({
        where: { status: PaymentStatus.CAPTURED, mode: "CASH", paidAt: { gte: dayStart }, session: { vendorId: user.vendorId } },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: { status: PaymentStatus.CAPTURED, mode: { not: "CASH" }, paidAt: { gte: dayStart }, session: { vendorId: user.vendorId } },
        _sum: { amount: true },
      }),
      this.prisma.settlement.aggregate({
        where: { vendorId: user.vendorId, status: { in: [SettlementStatus.PENDING_APPROVAL, SettlementStatus.APPROVED] } },
        _sum: { vendorShare: true },
      }),
      this.prisma.shift.count({ where: { vendorId: user.vendorId, status: "OPEN" } }),
    ]);

    const cash = todayCash._sum.amount ?? 0;
    const digital = todayDigital._sum.amount ?? 0;

    return {
      activeParking: active,
      sessionsToday: todaySessions,
      cashToday: cash,
      digitalToday: digital,
      collectedToday: cash + digital,
      settlementDue: pending._sum.vendorShare ?? 0,
      openShifts,
    };
  }
}
