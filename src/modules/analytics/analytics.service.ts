import { Injectable } from "@nestjs/common";
import {
  IncidentStatus,
  PassStatus,
  PaymentMode,
  PaymentStatus,
  Prisma,
  SessionStatus,
  SettlementStatus,
  ShiftStatus,
  UserStatus,
  VendorStatus,
  ZoneStatus,
} from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { SYSTEM_ROLES } from "@/common/rbac/permissions";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { scoped, zoneScopeOf } from "@/common/rbac/scope";

const CAPTURED: PaymentStatus[] = [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED];
const LIVE: SessionStatus[] = [SessionStatus.ACTIVE, SessionStatus.OVERSTAY];

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The numbers on the dashboard.
 *
 * Everything here is counted at read time from the tables that own the fact.
 * There are no roll-up columns to keep in step, because a stale counter on a
 * dashboard is worse than a slow one: nobody notices it is wrong.
 *
 * Money is net of refunds throughout, and "today" means today in the
 * authority's timezone as the server sees it.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private sessionScope(user: AuthenticatedUser): Prisma.ParkingSessionWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) return { vendorId: user.vendorId };
    const zones = zoneScopeOf(user);
    return zones ? { zoneId: { in: zones } } : {};
  }

  /** The same scope against the zone table, for the counts that start there. */
  private zoneScope(user: AuthenticatedUser): Prisma.ZoneWhereInput {
    const zones = zoneScopeOf(user);
    return zones ? { id: { in: zones } } : {};
  }

  private paymentScope(user: AuthenticatedUser): Prisma.PaymentWhereInput {
    const scope = this.sessionScope(user);
    return Object.keys(scope).length ? { session: scope } : {};
  }

  /**
   * Incidents, scoped exactly the way `IncidentsService` scopes them.
   *
   * Matching the shape matters as much as being safe here, because the tile is
   * a link: an officer who reads "9 open incidents" and lands on a list of four
   * has been told the dashboard is broken. An incident is attached either to a
   * zone directly or to the session it was raised against, so both routes have
   * to be checked — filtering on `zoneId` alone would drop every incident a
   * citizen raised against a session in the officer's own ward.
   */
  private async incidentScope(user: AuthenticatedUser): Promise<Prisma.IncidentWhereInput> {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) {
      const zones = await this.prisma.vendorZone.findMany({
        where: { vendorId: user.vendorId },
        select: { zoneId: true },
      });
      const zoneIds = zones.map((z) => z.zoneId);
      return {
        OR: [
          { session: { vendorId: user.vendorId } },
          ...(zoneIds.length ? [{ zoneId: { in: zoneIds } }] : []),
        ],
      };
    }
    const zones = zoneScopeOf(user);
    if (zones) {
      return { OR: [{ zoneId: { in: zones } }, { session: { zoneId: { in: zones } } }] };
    }
    return {};
  }

  /**
   * Shifts, scoped the way `ShiftsService` scopes them.
   *
   * A shift is where the cash is, so the variance and awaiting-verification
   * counts are the numbers an officer chases people about. Unscoped they were
   * the whole city's, which turns a ward officer's morning into a hunt for four
   * unexplained deposits that are not theirs to explain.
   */
  private shiftScope(user: AuthenticatedUser): Prisma.ShiftWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) return { vendorId: user.vendorId };
    if (user.role === SYSTEM_ROLES.ATTENDANT && user.attendantId) {
      return { attendantId: user.attendantId };
    }
    const zones = zoneScopeOf(user);
    return zones ? { zoneId: { in: zones } } : {};
  }

  /** Attendants, scoped the way `AttendantsService` scopes them — by posting. */
  private attendantScope(user: AuthenticatedUser): Prisma.AttendantWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) return { vendorId: user.vendorId };
    const zones = zoneScopeOf(user);
    return zones === null ? {} : { defaultZoneId: { in: zones } };
  }

  async overview(user: AuthenticatedUser) {
    const now = new Date();
    const today = startOfDay(now);
    const yesterday = addDays(today, -1);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const sessionScope = this.sessionScope(user);
    const paymentScope = this.paymentScope(user);
    // Awaited rather than folded into the batch below: a vendor's incident
    // scope has to look up the zones they hold before it can be expressed.
    const incidentScope = await this.incidentScope(user);
    const shiftScope = this.shiftScope(user);

    // Two kinds of figure come back from here and the difference is deliberate.
    //
    // Everything drawn from zones, sessions, payments, incidents, shifts and
    // attendants is narrowed to what this caller may see, because every one of
    // those rows belongs to a ward and the screens they link through to are
    // narrowed the same way.
    //
    // The rest — vendors, citizens, passes, settlements and the payout total —
    // is authority-wide on purpose. None of those rows carries a zone, and the
    // portal now labels them as authority-wide on the officer's dashboard. Each
    // is marked below, because the label and the query have to be changed
    // together or the dashboard starts lying about which of the two it is.

    const collected = async (from: Date, to?: Date) => {
      const result = await this.prisma.payment.aggregate({
        where: {
          ...paymentScope,
          status: { in: CAPTURED },
          paidAt: { gte: from, ...(to ? { lt: to } : {}) },
        },
        _sum: { amount: true, refundedAmount: true },
      });
      return (result._sum.amount ?? 0) - (result._sum.refundedAmount ?? 0);
    };

    const [
      zones,
      activeSessions,
      overstaying,
      sessionsToday,
      revenueToday,
      revenueYesterday,
      revenueMonth,
      byModeToday,
      openIncidents,
      shifts,
      pendingSettlements,
      vendors,
      attendants,
      citizens,
      awaitingPayout,
      activePasses,
    ] = await Promise.all([
      this.prisma.zone.findMany({
        where: this.zoneScope(user),
        select: { id: true, capacity: true, status: true },
      }),
      this.prisma.parkingSession.count({ where: { ...sessionScope, status: { in: LIVE } } }),
      this.prisma.parkingSession.count({
        where: { ...sessionScope, status: SessionStatus.OVERSTAY },
      }),
      this.prisma.parkingSession.count({ where: { ...sessionScope, startAt: { gte: today } } }),
      collected(today),
      collected(yesterday, today),
      collected(monthStart),
      this.prisma.payment.groupBy({
        by: ["mode"],
        where: { ...paymentScope, status: { in: CAPTURED }, paidAt: { gte: today } },
        _sum: { amount: true, refundedAmount: true },
      }),
      this.prisma.incident.count({
        where: scoped<Prisma.IncidentWhereInput>(incidentScope, {
          status: { in: [IncidentStatus.OPEN, IncidentStatus.IN_PROGRESS] },
        }),
      }),
      this.prisma.shift.groupBy({ by: ["status"], where: shiftScope, _count: { _all: true } }),
      // Authority-wide. A Settlement carries no zone: one row is a vendor's
      // whole period across every kerb they hold, so there is no ward-sized
      // count to give an officer, and a quarter of a settlement is not a
      // number that reconciles against anything. It is a scalar with no names
      // in it, and the officer cannot act on it in any case —
      // `settlement.approve` is not theirs. Narrowing it to the vendor who owns
      // it belongs in SettlementsService, which already does exactly that.
      this.prisma.settlement.count({ where: { status: SettlementStatus.PENDING_APPROVAL } }),
      // Authority-wide: a vendor is an organisation the authority contracts
      // with, not something that lives in a ward.
      this.prisma.vendor.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.attendant.count({
        where: scoped<Prisma.AttendantWhereInput>(this.attendantScope(user), { isActive: true }),
      }),
      // Authority-wide: a citizen registers with the city, not with a kerb.
      this.prisma.user.count({
        where: { role: SYSTEM_ROLES.CITIZEN, status: UserStatus.ACTIVE, deletedAt: null },
      }),
      // Authority-wide, for the same reason as the settlement count above —
      // this is the payout side of the very same rows.
      this.prisma.settlement.aggregate({
        where: { status: SettlementStatus.APPROVED },
        _sum: { vendorShare: true },
      }),
      // Authority-wide: a pass is bought against the city and is honoured
      // wherever it is valid, so it belongs to no single zone.
      this.prisma.pass.count({ where: { status: PassStatus.ACTIVE, validTo: { gte: now } } }),
    ]);

    const totalCapacity = zones.reduce((s, z) => s + z.capacity, 0);
    const cash = byModeToday
      .filter((m) => m.mode === PaymentMode.CASH)
      .reduce((s, m) => s + (m._sum.amount ?? 0) - (m._sum.refundedAmount ?? 0), 0);
    const upi = byModeToday
      .filter((m) => m.mode === PaymentMode.UPI_QR || m.mode === PaymentMode.UPI_INTENT)
      .reduce((s, m) => s + (m._sum.amount ?? 0) - (m._sum.refundedAmount ?? 0), 0);
    const digital = byModeToday
      .filter((m) => m.mode !== PaymentMode.CASH)
      .reduce((s, m) => s + (m._sum.amount ?? 0) - (m._sum.refundedAmount ?? 0), 0);

    const shiftCount = (status: ShiftStatus) =>
      shifts.find((s) => s.status === status)?._count._all ?? 0;

    // Occupied is the count of live sessions, not a column on the zone: a bay
    // can be occupied by a vehicle whose session was started against the zone
    // without a specific bay, and the session table is the one that knows.
    return {
      activeVehicles: activeSessions,
      totalCapacity,
      totalOccupied: activeSessions,
      availableSlots: Math.max(0, totalCapacity - activeSessions),
      occupancyPct: totalCapacity > 0 ? Math.round((activeSessions / totalCapacity) * 100) : 0,

      revenueToday,
      revenueYesterday,
      revenueMonth,

      cashCollection: cash,
      digitalCollection: digital,
      upiCollection: upi,

      // Authority-wide — see the queries above. The portal labels this one and
      // the four below as authority-wide on a zone officer's dashboard.
      pendingVendorPayments: awaitingPayout._sum.vendorShare ?? 0,

      sessionsToday,
      overstayCount: overstaying,
      openIncidents,
      openShifts: shiftCount(ShiftStatus.OPEN),
      varianceShifts: shiftCount(ShiftStatus.VARIANCE_FLAGGED),
      awaitingVerification: shiftCount(ShiftStatus.CLOSED),
      pendingSettlements, // authority-wide
      pendingVendorApprovals: vendors.find((v) => v.status === VendorStatus.PENDING)?._count._all ?? 0, // authority-wide

      activeVendors: vendors.find((v) => v.status === VendorStatus.APPROVED)?._count._all ?? 0, // authority-wide
      attendantsOnShift: shiftCount(ShiftStatus.OPEN),
      totalAttendants: attendants,
      registeredCitizens: citizens, // authority-wide
      activePasses, // authority-wide
      zonesOpen: zones.filter((z) => z.status === ZoneStatus.OPEN).length,
      zonesTotal: zones.length,
    };
  }

  /**
   * Today by the hour: how many vehicles were parked, and how many arrived.
   *
   * Occupancy is an overlap question — a session started at 09:40 and ended at
   * 14:10 was present for every hour in between — so it cannot be answered by
   * grouping on the start time. The day's sessions are small enough to fold in
   * memory, which keeps this correct and portable.
   */
  async hourly(user: AuthenticatedUser, date?: Date) {
    const day = startOfDay(date ?? new Date());
    const next = addDays(day, 1);

    const sessions = await this.prisma.parkingSession.findMany({
      where: {
        ...this.sessionScope(user),
        status: { not: SessionStatus.CANCELLED },
        startAt: { lt: next },
        OR: [{ endAt: null }, { endAt: { gte: day } }],
      },
      select: { startAt: true, endAt: true },
    });

    return Array.from({ length: 24 }, (_, hour) => {
      const from = new Date(day.getTime() + hour * 60 * 60 * 1000);
      const to = new Date(from.getTime() + 60 * 60 * 1000);

      const occupancy = sessions.filter(
        (s) => s.startAt < to && (s.endAt === null || s.endAt > from),
      ).length;
      const started = sessions.filter((s) => s.startAt >= from && s.startAt < to).length;

      return {
        hour: `${String(hour).padStart(2, "0")}:00`,
        occupancy,
        sessions: started,
      };
    });
  }

  /** The last N days: cash, digital and session count per day. */
  async daily(user: AuthenticatedUser, days = 30) {
    const today = startOfDay(new Date());
    const from = addDays(today, -(days - 1));
    const to = addDays(today, 1);

    const [payments, sessions] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          ...this.paymentScope(user),
          status: { in: CAPTURED },
          paidAt: { gte: from, lt: to },
        },
        select: { amount: true, refundedAmount: true, mode: true, paidAt: true },
      }),
      this.prisma.parkingSession.findMany({
        where: { ...this.sessionScope(user), startAt: { gte: from, lt: to } },
        select: { startAt: true },
      }),
    ]);

    const buckets = new Map<string, { cash: number; digital: number; sessions: number }>();
    for (let i = 0; i < days; i += 1) {
      const day = addDays(from, i);
      buckets.set(day.toISOString().slice(0, 10), { cash: 0, digital: 0, sessions: 0 });
    }

    for (const payment of payments) {
      const key = startOfDay(payment.paidAt ?? new Date()).toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      const net = payment.amount - payment.refundedAmount;
      if (payment.mode === PaymentMode.CASH) bucket.cash += net;
      else bucket.digital += net;
    }

    for (const session of sessions) {
      const key = startOfDay(session.startAt).toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (bucket) bucket.sessions += 1;
    }

    return [...buckets.entries()].map(([date, values]) => ({
      date,
      // "12 Aug" — what the axis shows.
      label: new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
      }),
      ...values,
    }));
  }

  /**
   * What has just happened across the network.
   *
   * Five tables, merged and sorted by time. There is no event log to read from
   * — the audit trail records who changed what, which is a different question
   * from what the kerb is doing — so this asks each table for its most recent
   * rows and interleaves them. Each is capped at `limit` so one very busy kind
   * cannot crowd the others out of the query itself.
   */
  async feed(user: AuthenticatedUser, limit = 40) {
    const sessionScope = this.sessionScope(user);
    // The session and payment halves of the feed were scoped from the start and
    // the incident and shift halves were not, which is the worst of both: the
    // feed looked local, so another ward's incident arriving in it read as
    // something happening on the officer's own kerb.
    const incidentScope = await this.incidentScope(user);
    const shiftScope = this.shiftScope(user);

    const [starts, ends, payments, incidents, shifts] = await Promise.all([
      this.prisma.parkingSession.findMany({
        where: sessionScope,
        select: {
          id: true,
          code: true,
          plateNumber: true,
          startAt: true,
          zone: { select: { name: true } },
        },
        orderBy: { startAt: "desc" },
        take: limit,
      }),
      this.prisma.parkingSession.findMany({
        where: { ...sessionScope, endAt: { not: null } },
        select: {
          id: true,
          code: true,
          plateNumber: true,
          endAt: true,
          payableAmount: true,
          zone: { select: { name: true } },
        },
        orderBy: { endAt: "desc" },
        take: limit,
      }),
      this.prisma.payment.findMany({
        where: { ...this.paymentScope(user), status: { in: CAPTURED } },
        select: {
          id: true,
          amount: true,
          mode: true,
          paidAt: true,
          session: { select: { code: true, plateNumber: true, zone: { select: { name: true } } } },
        },
        orderBy: { paidAt: "desc" },
        take: limit,
      }),
      this.prisma.incident.findMany({
        where: incidentScope,
        select: { id: true, type: true, createdAt: true, zoneId: true, description: true },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      this.prisma.shift.findMany({
        where: shiftScope,
        select: {
          id: true,
          startAt: true,
          endAt: true,
          status: true,
          attendant: { select: { user: { select: { name: true } } } },
          zone: { select: { name: true } },
        },
        orderBy: { startAt: "desc" },
        take: limit,
      }),
    ]);

    const zoneIds = [...new Set(incidents.map((i) => i.zoneId).filter((z): z is string => Boolean(z)))];
    const zones = zoneIds.length
      ? await this.prisma.zone.findMany({
          where: { id: { in: zoneIds } },
          select: { id: true, name: true },
        })
      : [];
    const zoneName = new Map(zones.map((z) => [z.id, z.name]));

    const items = [
      ...starts.map((s) => ({
        id: `start_${s.id}`,
        kind: "session_start" as const,
        label: s.plateNumber,
        detail: `Session ${s.code} started`,
        zoneName: s.zone?.name ?? "—",
        amount: undefined as number | undefined,
        at: s.startAt,
      })),
      ...ends.map((s) => ({
        id: `end_${s.id}`,
        kind: "session_end" as const,
        label: s.plateNumber,
        detail: `Session ${s.code} ended`,
        zoneName: s.zone?.name ?? "—",
        amount: s.payableAmount ?? undefined,
        at: s.endAt as Date,
      })),
      ...payments.map((p) => ({
        id: `pay_${p.id}`,
        kind: "payment" as const,
        label: p.session?.plateNumber ?? "Payment",
        detail: `Collected by ${p.mode.toLowerCase().replace(/_/g, " ")}`,
        zoneName: p.session?.zone?.name ?? "—",
        amount: p.amount,
        at: p.paidAt as Date,
      })),
      ...incidents.map((i) => ({
        id: `inc_${i.id}`,
        kind: "incident" as const,
        label: i.type.toLowerCase().replace(/_/g, " "),
        detail: i.description.slice(0, 90),
        zoneName: (i.zoneId && zoneName.get(i.zoneId)) || "—",
        amount: undefined as number | undefined,
        at: i.createdAt,
      })),
      ...shifts.map((s) => ({
        id: `shift_${s.id}`,
        kind: "shift" as const,
        label: s.attendant?.user.name ?? "Attendant",
        detail: s.endAt ? `Shift closed — ${s.status.toLowerCase()}` : "Shift opened",
        zoneName: s.zone?.name ?? "—",
        amount: undefined as number | undefined,
        at: s.endAt ?? s.startAt,
      })),
    ];

    return items
      .filter((item) => item.at instanceof Date)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit);
  }

  /** Zones ranked by what they took today, with their live occupancy. */
  async topZones(user: AuthenticatedUser, limit = 6) {
    const today = startOfDay(new Date());

    const zones = await this.prisma.zone.findMany({
      where: this.zoneScope(user),
      select: {
        id: true,
        code: true,
        name: true,
        capacity: true,
        status: true,
        openTime: true,
        closeTime: true,
        ward: { select: { name: true } },
        street: { select: { name: true } },
        vendorZones: { select: { vendor: { select: { orgName: true } } }, take: 1 },
      },
    });
    if (zones.length === 0) return [];

    const zoneIds = zones.map((z) => z.id);

    const [payments, occupied] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          status: { in: CAPTURED },
          paidAt: { gte: today },
          session: { zoneId: { in: zoneIds } },
        },
        select: { amount: true, refundedAmount: true, session: { select: { zoneId: true } } },
      }),
      this.prisma.parkingSession.groupBy({
        by: ["zoneId"],
        where: { zoneId: { in: zoneIds }, status: { in: LIVE } },
        _count: { _all: true },
      }),
    ]);

    const revenueByZone = new Map<string, number>();
    for (const payment of payments) {
      if (!payment.session) continue;
      const net = payment.amount - payment.refundedAmount;
      revenueByZone.set(
        payment.session.zoneId,
        (revenueByZone.get(payment.session.zoneId) ?? 0) + net,
      );
    }
    const occupiedByZone = new Map(occupied.map((o) => [o.zoneId, o._count._all]));

    return zones
      .map((zone) => ({
        id: zone.id,
        code: zone.code,
        name: zone.name,
        wardName: zone.ward?.name ?? null,
        streetName: zone.street?.name ?? null,
        vendorName: zone.vendorZones[0]?.vendor.orgName ?? null,
        capacity: zone.capacity,
        occupied: occupiedByZone.get(zone.id) ?? 0,
        status: zone.status,
        openTime: zone.openTime,
        closeTime: zone.closeTime,
        revenueToday: revenueByZone.get(zone.id) ?? 0,
      }))
      .sort((a, b) => b.revenueToday - a.revenueToday)
      .slice(0, limit);
  }
}
