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
    if (user.isZoneScoped && user.zoneIds.length > 0) return { zoneId: { in: user.zoneIds } };
    return {};
  }

  private paymentScope(user: AuthenticatedUser): Prisma.PaymentWhereInput {
    const scope = this.sessionScope(user);
    return Object.keys(scope).length ? { session: scope } : {};
  }

  async overview(user: AuthenticatedUser) {
    const now = new Date();
    const today = startOfDay(now);
    const yesterday = addDays(today, -1);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const sessionScope = this.sessionScope(user);
    const paymentScope = this.paymentScope(user);

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
        where: user.isZoneScoped && user.zoneIds.length ? { id: { in: user.zoneIds } } : {},
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
        where: { status: { in: [IncidentStatus.OPEN, IncidentStatus.IN_PROGRESS] } },
      }),
      this.prisma.shift.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.settlement.count({ where: { status: SettlementStatus.PENDING_APPROVAL } }),
      this.prisma.vendor.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.attendant.count({ where: { isActive: true } }),
      this.prisma.user.count({
        where: { role: SYSTEM_ROLES.CITIZEN, status: UserStatus.ACTIVE, deletedAt: null },
      }),
      this.prisma.settlement.aggregate({
        where: { status: SettlementStatus.APPROVED },
        _sum: { vendorShare: true },
      }),
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

      pendingVendorPayments: awaitingPayout._sum.vendorShare ?? 0,

      sessionsToday,
      overstayCount: overstaying,
      openIncidents,
      openShifts: shiftCount(ShiftStatus.OPEN),
      varianceShifts: shiftCount(ShiftStatus.VARIANCE_FLAGGED),
      awaitingVerification: shiftCount(ShiftStatus.CLOSED),
      pendingSettlements,
      pendingVendorApprovals: vendors.find((v) => v.status === VendorStatus.PENDING)?._count._all ?? 0,

      activeVendors: vendors.find((v) => v.status === VendorStatus.APPROVED)?._count._all ?? 0,
      attendantsOnShift: shiftCount(ShiftStatus.OPEN),
      totalAttendants: attendants,
      registeredCitizens: citizens,
      activePasses,
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
        select: { id: true, type: true, createdAt: true, zoneId: true, description: true },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      this.prisma.shift.findMany({
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
      where: user.isZoneScoped && user.zoneIds.length ? { id: { in: user.zoneIds } } : {},
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
