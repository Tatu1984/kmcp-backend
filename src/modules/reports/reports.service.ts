import { Injectable, Logger } from "@nestjs/common";
import {
  PaymentMode,
  PaymentStatus,
  Prisma,
  ReportStatus,
  SessionStatus,
  UserStatus,
} from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { skipTake } from "@/common/dto/pagination.dto";
import { SYSTEM_ROLES } from "@/common/rbac/permissions";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { scoped, zoneScopeOf } from "@/common/rbac/scope";
import type { GenerateReportDto, ReportQueryDto } from "./dto/report.dto";
import { REPORT_TYPES, reportAudience, reportLabel, type ReportKey } from "./report-types";

type Ctx = { ip?: string; requestId?: string };

const CAPTURED: PaymentStatus[] = [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED];

export interface ReportTable {
  columns: string[];
  rows: (string | number)[][];
}

/** Paise to rupees, as a plain decimal string — spreadsheets do the rest. */
function rupees(paise: number): string {
  return (paise / 100).toFixed(2);
}

function day(date: Date | null | undefined): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

/**
 * Reports.
 *
 * Two decisions shape this module.
 *
 * They run inline rather than on a queue. A serverless deployment has no
 * process that stays alive to drain one, so a job left QUEUED would sit there
 * forever looking like a backlog. A report over a period of this size takes
 * well under a request timeout.
 *
 * And the output is regenerated on download rather than stored. Nothing is
 * cached to object storage, so a report can never disagree with the data it
 * claims to describe — the trade is that downloading an old report re-runs it,
 * which for an audit trail is the safer direction to be wrong in.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Whether this principal may run this report at all.
   *
   * Most of the catalogue reads parking sessions, which carry a zone, so a
   * scoped caller gets a real report about their own ward. Three do not: the
   * citizen register, the audit trail and vendor settlement read rows that have
   * no zone on them to filter by.
   *
   * They could have been narrowed by a proxy — the citizens who happened to
   * park in this ward, the settlements of the vendors who operate it — and that
   * is the option deliberately not taken. "The citizens who parked in my ward"
   * is a different report from "the citizen register", and returning the first
   * under the heading of the second is its own kind of wrong: the officer
   * cannot see that anything was withheld, quotes the total as the authority's
   * total, and an audit trail with rows silently missing is more dangerous than
   * no audit trail, because it is the artefact people trust to be complete.
   *
   * So a scoped caller is refused outright rather than quietly served a
   * different report, and `catalogue()` stops offering them the button.
   *
   * The one exception is a vendor's own settlement. That is their own money,
   * the report was already filtered to their vendor id, and refusing it would
   * take away a statement they are entitled to.
   */
  private mayRun(type: ReportKey, user: AuthenticatedUser): boolean {
    if (reportAudience(type) === "zonal") return true;
    if (type === "settlement" && user.role === SYSTEM_ROLES.VENDOR && user.vendorId) return true;
    return zoneScopeOf(user) === null;
  }

  /**
   * Public because a scheduled run has to pass the same gate as a pressed
   * button, and `ReportSchedulesService` needs to apply it at the moment a
   * schedule is *written* as well as at the moment it fires. Refusing at write
   * time is a courtesy — the run would refuse anyway, three days later, having
   * told nobody in the meantime.
   */
  assertMayRun(type: ReportKey, user: AuthenticatedUser): void {
    if (this.mayRun(type, user)) return;
    throw AppException.forbidden(
      `The ${reportLabel(type).toLowerCase()} covers the whole authority and has no version ` +
        "narrowed to a zone. Ask an administrator to run it.",
    );
  }

  /**
   * The catalogue as this caller sees it.
   *
   * Served filtered rather than whole, because the grid is built from it: an
   * unfiltered catalogue puts three tiles on a ward officer's reports screen
   * that answer 403 when pressed, which reads as a broken portal rather than as
   * a boundary being held.
   */
  catalogue(user: AuthenticatedUser) {
    return REPORT_TYPES.filter((type) => this.mayRun(type.key, user));
  }

  /**
   * Whose report jobs this caller may see.
   *
   * A job row is not zone data and cannot be filtered into a ward — but it
   * carries the requester's name and the parameters they chose, so an
   * unfiltered history tells a ward officer which zones, vendors and periods
   * head office has been pulling apart, and hands them the ids to try against
   * the download route. The line is therefore drawn at authorship: a restricted
   * caller sees the reports they ran themselves and nobody else's.
   */
  private jobScopeOf(user: AuthenticatedUser): Prisma.ReportJobWhereInput {
    return zoneScopeOf(user) === null ? {} : { requestedById: user.id };
  }

  async list(query: ReportQueryDto, user: AuthenticatedUser) {
    const where = scoped<Prisma.ReportJobWhereInput>(this.jobScopeOf(user), {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.mine ? { requestedById: user.id } : {}),
    });

    const [jobs, total] = await this.prisma.$transaction([
      this.prisma.reportJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...skipTake(query),
      }),
      this.prisma.reportJob.count({ where }),
    ]);

    const requesterIds = [...new Set(jobs.map((j) => j.requestedById))];
    const requesters = requesterIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: requesterIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(requesters.map((r) => [r.id, r.name]));

    return new Paginated(
      jobs.map((job) => ({
        ...job,
        label: reportLabel(job.type),
        requestedBy: nameById.get(job.requestedById) ?? "—",
        paramsLabel: this.describe(job.params),
      })),
      query.page,
      query.pageSize,
      total,
    );
  }

  /** "01 Aug – 05 Aug 2026 · All zones" — what the history column shows. */
  private describe(params: Prisma.JsonValue): string {
    if (!params || typeof params !== "object" || Array.isArray(params)) return "—";
    const p = params as Record<string, unknown>;
    const from = typeof p.from === "string" ? new Date(p.from) : null;
    const to = typeof p.to === "string" ? new Date(p.to) : null;
    const period =
      from && to
        ? `${from.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} – ${to.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`
        : "—";
    const scope = p.zoneId ? "One zone" : p.vendorId ? "One vendor" : "All zones";
    return `${period} · ${scope}`;
  }

  async generate(dto: GenerateReportDto, user: AuthenticatedUser, ctx: Ctx) {
    // Checked before the row is written as well as inside `build`. A refusal is
    // not a failed report, and recording it as one would leave a FAILED job in
    // the history for something that never began.
    this.assertMayRun(dto.type, user);

    const job = await this.prisma.reportJob.create({
      data: {
        type: dto.type,
        params: {
          from: dto.from.toISOString(),
          to: dto.to.toISOString(),
          zoneId: dto.zoneId ?? null,
          vendorId: dto.vendorId ?? null,
          format: dto.format,
        },
        status: ReportStatus.RUNNING,
        requestedById: user.id,
      },
    });

    try {
      const table = await this.build(dto.type, dto, user);

      const completed = await this.prisma.reportJob.update({
        where: { id: job.id },
        data: { status: ReportStatus.COMPLETED, completedAt: new Date() },
      });

      await this.audit.record({
        actor: user,
        action: "REPORT_GENERATE",
        entity: "ReportJob",
        entityId: job.id,
        after: { type: dto.type, rows: table.rows.length },
        ...ctx,
      });

      return {
        ...completed,
        label: reportLabel(completed.type),
        requestedBy: user.name,
        paramsLabel: this.describe(completed.params),
        rowCount: table.rows.length,
      };
    } catch (error) {
      // The job row stays, marked failed with the reason. A report that
      // vanished when it broke would leave the requester with nothing to quote.
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.error(`Report ${dto.type} failed: ${message}`);
      await this.prisma.reportJob.update({
        where: { id: job.id },
        data: { status: ReportStatus.FAILED, error: message, completedAt: new Date() },
      });
      throw error;
    }
  }

  /**
   * Re-runs the stored parameters and returns the file.
   *
   * Two things have to hold here, and only one of them used to. Re-running
   * under the caller's own principal means the rows obey the caller's scope
   * rather than the requester's — but that was worth nothing for the three
   * reports whose builders took no principal at all, so an officer who guessed
   * an administrator's job id was handed the entire citizen register. `build`
   * now refuses those, and the job itself is looked up through the same
   * visibility rule as the history, so a job the caller cannot see in the list
   * cannot be fetched by id either.
   */
  async download(id: string, user: AuthenticatedUser): Promise<{ filename: string; csv: string }> {
    const job = await this.prisma.reportJob.findFirst({
      where: scoped<Prisma.ReportJobWhereInput>(this.jobScopeOf(user), { id }),
    });
    if (!job) throw AppException.notFound("report");

    const params = (job.params ?? {}) as Record<string, unknown>;
    const dto = {
      type: job.type as ReportKey,
      from: new Date(String(params.from)),
      to: new Date(String(params.to)),
      zoneId: (params.zoneId as string | null) ?? undefined,
      vendorId: (params.vendorId as string | null) ?? undefined,
      format: "csv" as const,
    };

    const table = await this.build(dto.type, dto, user);
    return {
      filename: `${job.type}-${day(dto.from)}-to-${day(dto.to)}.csv`,
      csv: toCsv(table),
    };
  }

  private async build(
    type: ReportKey,
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Promise<ReportTable> {
    // The choke point. `download` re-enters here without passing through
    // `generate`, so the gate has to live where every builder is reached from
    // rather than at the entry the request happened to arrive by.
    this.assertMayRun(type, user);

    switch (type) {
      case "revenue":
        return this.revenue(dto, user);
      case "daily-collection":
        return this.dailyCollection(dto, user);
      case "monthly-collection":
        return this.monthlyCollection(dto, user);
      case "government-revenue":
        return this.governmentRevenue(dto, user);
      case "vendor":
        return this.vendorPerformance(dto, user);
      case "settlement":
        return this.settlement(dto, user);
      case "occupancy":
        return this.occupancy(dto, user);
      case "duration":
        return this.duration(dto, user);
      case "user":
        return this.citizens(dto);
      case "tax":
        return this.tax(dto, user);
      case "audit":
        return this.auditTrail(dto);
    }
  }

  /**
   * What this caller may be reported on, whatever period they asked for.
   *
   * Kept in one place because both `where` builders below need it and both used
   * to inline it — and inline, spread last, it silently discarded the `zoneId`
   * the caller had asked for and reported on their own zones under the other
   * zone's heading.
   */
  private sessionScopeOf(user: AuthenticatedUser): Prisma.ParkingSessionWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) return { vendorId: user.vendorId };
    const zones = zoneScopeOf(user);
    return zones ? { zoneId: { in: zones } } : {};
  }

  private paymentWhere(
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Prisma.PaymentWhereInput {
    const session = scoped<Prisma.ParkingSessionWhereInput>(this.sessionScopeOf(user), {
      ...(dto.zoneId ? { zoneId: dto.zoneId } : {}),
      ...(dto.vendorId ? { vendorId: dto.vendorId } : {}),
    });
    return {
      status: { in: CAPTURED },
      paidAt: { gte: dto.from, lte: dto.to },
      ...(Object.keys(session).length ? { session } : {}),
    };
  }

  private sessionWhere(
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Prisma.ParkingSessionWhereInput {
    return scoped<Prisma.ParkingSessionWhereInput>(this.sessionScopeOf(user), {
      startAt: { gte: dto.from, lte: dto.to },
      ...(dto.zoneId ? { zoneId: dto.zoneId } : {}),
      ...(dto.vendorId ? { vendorId: dto.vendorId } : {}),
    });
  }

  private async revenue(
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Promise<ReportTable> {
    const payments = await this.prisma.payment.findMany({
      where: this.paymentWhere(dto, user),
      select: {
        id: true,
        amount: true,
        refundedAmount: true,
        mode: true,
        paidAt: true,
        receipt: { select: { number: true } },
        session: {
          select: {
            code: true,
            plateNumber: true,
            zone: { select: { name: true } },
            vendor: { select: { orgName: true } },
          },
        },
      },
      orderBy: { paidAt: "asc" },
    });

    return {
      columns: [
        "Date",
        "Receipt",
        "Session",
        "Plate",
        "Zone",
        "Vendor",
        "Method",
        "Amount (₹)",
        "Refunded (₹)",
        "Net (₹)",
      ],
      rows: payments.map((p) => [
        day(p.paidAt),
        p.receipt?.number ?? "",
        p.session?.code ?? "",
        p.session?.plateNumber ?? "",
        p.session?.zone?.name ?? "",
        p.session?.vendor?.orgName ?? "",
        p.mode,
        rupees(p.amount),
        rupees(p.refundedAmount),
        rupees(p.amount - p.refundedAmount),
      ]),
    };
  }

  private async dailyCollection(
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Promise<ReportTable> {
    const payments = await this.prisma.payment.findMany({
      where: this.paymentWhere(dto, user),
      select: { amount: true, refundedAmount: true, mode: true, paidAt: true },
    });

    const byDay = new Map<string, { cash: number; digital: number; count: number }>();
    for (const p of payments) {
      const key = day(p.paidAt);
      const bucket = byDay.get(key) ?? { cash: 0, digital: 0, count: 0 };
      const net = p.amount - p.refundedAmount;
      if (p.mode === PaymentMode.CASH) bucket.cash += net;
      else bucket.digital += net;
      bucket.count += 1;
      byDay.set(key, bucket);
    }

    return {
      columns: ["Date", "Payments", "Cash (₹)", "Digital (₹)", "Total (₹)"],
      rows: [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, v]) => [date, v.count, rupees(v.cash), rupees(v.digital), rupees(v.cash + v.digital)]),
    };
  }

  private async monthlyCollection(
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Promise<ReportTable> {
    const payments = await this.prisma.payment.findMany({
      where: this.paymentWhere(dto, user),
      select: { amount: true, refundedAmount: true, mode: true, paidAt: true },
    });

    const byMonth = new Map<string, { cash: number; digital: number; count: number }>();
    for (const p of payments) {
      const key = day(p.paidAt).slice(0, 7);
      const bucket = byMonth.get(key) ?? { cash: 0, digital: 0, count: 0 };
      const net = p.amount - p.refundedAmount;
      if (p.mode === PaymentMode.CASH) bucket.cash += net;
      else bucket.digital += net;
      bucket.count += 1;
      byMonth.set(key, bucket);
    }

    return {
      columns: ["Month", "Payments", "Cash (₹)", "Digital (₹)", "Total (₹)"],
      rows: [...byMonth.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([m, v]) => [m, v.count, rupees(v.cash), rupees(v.digital), rupees(v.cash + v.digital)]),
    };
  }

  private async governmentRevenue(
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Promise<ReportTable> {
    const payments = await this.prisma.payment.findMany({
      where: this.paymentWhere(dto, user),
      select: {
        amount: true,
        refundedAmount: true,
        session: { select: { vendorId: true } },
      },
    });

    const byVendor = new Map<string, number>();
    for (const p of payments) {
      if (!p.session) continue;
      byVendor.set(
        p.session.vendorId,
        (byVendor.get(p.session.vendorId) ?? 0) + p.amount - p.refundedAmount,
      );
    }

    const vendors = byVendor.size
      ? await this.prisma.vendor.findMany({
          where: { id: { in: [...byVendor.keys()] } },
          select: { id: true, orgName: true, commissionPct: true },
        })
      : [];

    return {
      columns: ["Vendor", "Commission %", "Gross (₹)", "Vendor share (₹)", "Municipal share (₹)"],
      rows: vendors.map((v) => {
        const gross = byVendor.get(v.id) ?? 0;
        const commission = Math.round((gross * Number(v.commissionPct)) / 100);
        return [
          v.orgName,
          Number(v.commissionPct),
          rupees(gross),
          rupees(commission),
          rupees(gross - commission),
        ];
      }),
    };
  }

  private async vendorPerformance(
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Promise<ReportTable> {
    const sessions = await this.prisma.parkingSession.groupBy({
      by: ["vendorId"],
      where: this.sessionWhere(dto, user),
      _count: { _all: true },
      _sum: { payableAmount: true, durationMinutes: true },
    });

    const vendors = sessions.length
      ? await this.prisma.vendor.findMany({
          where: { id: { in: sessions.map((s) => s.vendorId) } },
          select: {
            id: true,
            orgName: true,
            commissionPct: true,
            status: true,
            _count: { select: { zones: true, attendants: true } },
          },
        })
      : [];
    const byId = new Map(sessions.map((s) => [s.vendorId, s]));

    return {
      columns: [
        "Vendor",
        "Status",
        "Zones",
        "Attendants",
        "Sessions",
        "Gross (₹)",
        "Commission %",
        "Commission (₹)",
        "Avg stay (min)",
      ],
      rows: vendors.map((v) => {
        const row = byId.get(v.id);
        const gross = row?._sum.payableAmount ?? 0;
        const count = row?._count._all ?? 0;
        const minutes = row?._sum.durationMinutes ?? 0;
        return [
          v.orgName,
          v.status,
          v._count.zones,
          v._count.attendants,
          count,
          rupees(gross),
          Number(v.commissionPct),
          rupees(Math.round((gross * Number(v.commissionPct)) / 100)),
          count > 0 ? Math.round(minutes / count) : 0,
        ];
      }),
    };
  }

  /**
   * Vendor settlements for a period.
   *
   * Vendor-scoped and nothing else, because a Settlement has no zone on it to
   * scope by: one row is a vendor's whole period across every kerb they hold,
   * and slicing it by ward would produce a figure that reconciles against
   * nothing and matches no payout. `mayRun` is what keeps a ward officer out of
   * it; the filter below is what keeps one vendor out of another's.
   */
  private async settlement(
    dto: { from: Date; to: Date; vendorId?: string },
    user: AuthenticatedUser,
  ): Promise<ReportTable> {
    const settlements = await this.prisma.settlement.findMany({
      where: {
        periodStart: { gte: dto.from },
        periodEnd: { lte: dto.to },
        ...(dto.vendorId ? { vendorId: dto.vendorId } : {}),
        ...(user.role === SYSTEM_ROLES.VENDOR && user.vendorId ? { vendorId: user.vendorId } : {}),
      },
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        grossCollected: true,
        cashCollected: true,
        digitalCollected: true,
        commissionAmount: true,
        vendorShare: true,
        governmentShare: true,
        status: true,
        payoutRef: true,
        vendor: { select: { orgName: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { periodStart: "asc" },
    });

    return {
      columns: [
        "Vendor",
        "Period start",
        "Period end",
        "Payments",
        "Gross (₹)",
        "Cash (₹)",
        "Digital (₹)",
        "Commission (₹)",
        "Vendor share (₹)",
        "Municipal share (₹)",
        "Status",
        "Payout reference",
      ],
      rows: settlements.map((s) => [
        s.vendor?.orgName ?? "",
        day(s.periodStart),
        day(s.periodEnd),
        s._count.lines,
        rupees(s.grossCollected),
        rupees(s.cashCollected),
        rupees(s.digitalCollected),
        rupees(s.commissionAmount),
        rupees(s.vendorShare),
        rupees(s.governmentShare),
        s.status,
        s.payoutRef ?? "",
      ]),
    };
  }

  private async occupancy(
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Promise<ReportTable> {
    const sessions = await this.prisma.parkingSession.groupBy({
      by: ["zoneId"],
      where: this.sessionWhere(dto, user),
      _count: { _all: true },
      _sum: { durationMinutes: true, payableAmount: true },
    });

    const zones = sessions.length
      ? await this.prisma.zone.findMany({
          where: { id: { in: sessions.map((s) => s.zoneId) } },
          select: {
            id: true,
            code: true,
            name: true,
            capacity: true,
            status: true,
            ward: { select: { name: true } },
          },
        })
      : [];
    const byId = new Map(sessions.map((s) => [s.zoneId, s]));

    const days = Math.max(
      1,
      Math.ceil((dto.to.getTime() - dto.from.getTime()) / (24 * 60 * 60 * 1000)),
    );

    return {
      columns: [
        "Zone",
        "Code",
        "Ward",
        "Capacity",
        "Sessions",
        "Turnover per bay",
        "Avg stay (min)",
        "Occupied bay-hours",
        "Utilisation %",
        "Revenue (₹)",
      ],
      rows: zones.map((z) => {
        const row = byId.get(z.id);
        const count = row?._count._all ?? 0;
        const minutes = row?._sum.durationMinutes ?? 0;
        // Utilisation is occupied bay-hours against the bay-hours available
        // over the period — the honest denominator, rather than a snapshot.
        const availableBayHours = z.capacity * 24 * days;
        const occupiedBayHours = minutes / 60;
        return [
          z.name,
          z.code,
          z.ward?.name ?? "",
          z.capacity,
          count,
          z.capacity > 0 ? (count / z.capacity).toFixed(2) : "0",
          count > 0 ? Math.round(minutes / count) : 0,
          occupiedBayHours.toFixed(1),
          availableBayHours > 0 ? ((occupiedBayHours / availableBayHours) * 100).toFixed(1) : "0",
          rupees(row?._sum.payableAmount ?? 0),
        ];
      }),
    };
  }

  private async duration(
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Promise<ReportTable> {
    const sessions = await this.prisma.parkingSession.findMany({
      where: {
        ...this.sessionWhere(dto, user),
        status: SessionStatus.COMPLETED,
        durationMinutes: { not: null },
      },
      select: { durationMinutes: true, payableAmount: true },
    });

    const bands = [
      { label: "Up to 30 min", min: 0, max: 30 },
      { label: "30–60 min", min: 30, max: 60 },
      { label: "1–2 hours", min: 60, max: 120 },
      { label: "2–4 hours", min: 120, max: 240 },
      { label: "4–8 hours", min: 240, max: 480 },
      { label: "Over 8 hours", min: 480, max: Number.POSITIVE_INFINITY },
    ];

    const total = sessions.length;
    return {
      columns: ["Duration band", "Sessions", "Share %", "Revenue (₹)", "Avg fare (₹)"],
      rows: bands.map((band) => {
        const inBand = sessions.filter(
          (s) => (s.durationMinutes ?? 0) > band.min && (s.durationMinutes ?? 0) <= band.max,
        );
        const revenue = inBand.reduce((sum, s) => sum + (s.payableAmount ?? 0), 0);
        return [
          band.label,
          inBand.length,
          total > 0 ? ((inBand.length / total) * 100).toFixed(1) : "0",
          rupees(revenue),
          inBand.length > 0 ? rupees(Math.round(revenue / inBand.length)) : "0.00",
        ];
      }),
    };
  }

  /**
   * The citizen register for a period.
   *
   * It takes no principal and applies no scope, and that is deliberate rather
   * than forgotten: `mayRun` above admits only a caller with no zone
   * restriction at all, so by the time execution arrives here there is nothing
   * left to narrow. A citizen row carries no zone in any case — the closest
   * proxy is where they happened to park, which answers a different question.
   *
   * If that gate is ever moved or widened, this method is what it was there to
   * protect: every citizen in the authority, with mobile number and email.
   */
  private async citizens(dto: { from: Date; to: Date }): Promise<ReportTable> {
    const users = await this.prisma.user.findMany({
      where: {
        role: SYSTEM_ROLES.CITIZEN,
        deletedAt: null,
        createdAt: { gte: dto.from, lte: dto.to },
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
        _count: { select: { vehicles: true, passes: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const vehicles = users.length
      ? await this.prisma.vehicle.findMany({
          where: { ownerUserId: { in: users.map((u) => u.id) } },
          select: { id: true, ownerUserId: true },
        })
      : [];
    const owners = new Map(vehicles.map((v) => [v.id, v.ownerUserId]));

    const sessionCounts = vehicles.length
      ? await this.prisma.parkingSession.groupBy({
          by: ["vehicleId"],
          where: { vehicleId: { in: vehicles.map((v) => v.id) } },
          _count: { _all: true },
        })
      : [];

    const byUser = new Map<string, number>();
    for (const row of sessionCounts) {
      const owner = owners.get(row.vehicleId);
      if (owner) byUser.set(owner, (byUser.get(owner) ?? 0) + row._count._all);
    }

    return {
      columns: [
        "Name",
        "Mobile",
        "Email",
        "Status",
        "Registered",
        "Last seen",
        "Vehicles",
        "Passes",
        "Sessions",
      ],
      rows: users.map((u) => [
        u.name,
        u.phone ?? "",
        u.email ?? "",
        u.status,
        day(u.createdAt),
        day(u.lastLoginAt),
        u._count.vehicles,
        u._count.passes,
        byUser.get(u.id) ?? 0,
      ]),
    };
  }

  private async tax(
    dto: { from: Date; to: Date; zoneId?: string; vendorId?: string },
    user: AuthenticatedUser,
  ): Promise<ReportTable> {
    const payments = await this.prisma.payment.findMany({
      where: {
        ...this.paymentWhere(dto, user),
        receipt: { isNot: null },
      },
      select: {
        amount: true,
        refundedAmount: true,
        paidAt: true,
        receipt: { select: { number: true, gstInvoiceNo: true, issuedAt: true } },
        session: {
          select: {
            code: true,
            taxAmount: true,
            payableAmount: true,
            vendor: { select: { orgName: true, gstin: true } },
          },
        },
      },
      orderBy: { paidAt: "asc" },
    });

    return {
      columns: [
        "Receipt",
        "GST invoice",
        "Issued",
        "Session",
        "Vendor",
        "Vendor GSTIN",
        "Taxable (₹)",
        "Tax (₹)",
        "Total (₹)",
      ],
      rows: payments.map((p) => {
        const tax = p.session?.taxAmount ?? 0;
        const total = p.amount - p.refundedAmount;
        return [
          p.receipt?.number ?? "",
          p.receipt?.gstInvoiceNo ?? "",
          day(p.receipt?.issuedAt),
          p.session?.code ?? "",
          p.session?.vendor?.orgName ?? "",
          p.session?.vendor?.gstin ?? "",
          rupees(Math.max(0, total - tax)),
          rupees(tax),
          rupees(total),
        ];
      }),
    };
  }

  /**
   * The complete before/after trail for a period.
   *
   * Unscoped for the same reason as the citizen register, and more emphatically
   * so: an audit trail is trusted precisely because it is whole. A copy with
   * some rows quietly dropped still looks complete to whoever reads it, which
   * is why `mayRun` refuses a scoped caller instead of filtering for them.
   */
  private async auditTrail(dto: { from: Date; to: Date }): Promise<ReportTable> {
    const entries = await this.prisma.auditLog.findMany({
      where: { createdAt: { gte: dto.from, lte: dto.to } },
      orderBy: { createdAt: "asc" },
      // An audit period can be very large; this is the one report with a cap,
      // and it is stated in the file rather than silently applied.
      take: 5000,
    });

    const actorIds = [...new Set(entries.map((e) => e.actorUserId).filter((id): id is string => Boolean(id)))];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, role: true },
        })
      : [];
    const byId = new Map(actors.map((a) => [a.id, a]));

    return {
      columns: ["When", "Actor", "Role", "Action", "Entity", "Entity id", "IP", "Before", "After"],
      rows: entries.map((e) => {
        const actor = e.actorUserId ? byId.get(e.actorUserId) : undefined;
        return [
          e.createdAt.toISOString(),
          actor?.name ?? "System",
          actor?.role ?? "",
          e.action,
          e.entity,
          e.entityId,
          e.ip ?? "",
          e.before ? JSON.stringify(e.before) : "",
          e.after ? JSON.stringify(e.after) : "",
        ];
      }),
    };
  }
}

/**
 * RFC 4180 quoting.
 *
 * A plate, a rejection reason or an audit payload can all contain a comma, a
 * quote or a newline, and a report that shifts every column right when one does
 * is worse than no report.
 */
export function toCsv(table: ReportTable): string {
  const escape = (value: string | number): string => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [
    table.columns.map(escape).join(","),
    ...table.rows.map((row) => row.map(escape).join(",")),
  ].join("\r\n");
}
