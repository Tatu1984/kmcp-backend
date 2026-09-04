import { Injectable, Logger } from "@nestjs/common";
import { SYSTEM_ROLES, type RoleCode } from "@/common/rbac/permissions";
import {
  Prisma,
  SessionSource,
  SessionStatus,
  SlotStatus,
  SlotType,
  ZoneStatus,
  PaymentStatus,
} from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { IdempotencyService } from "@/common/services/idempotency.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import { withinZone, type GeoPolygon } from "@/common/utils/geo.util";
import { generateSessionCode, isValidPlate, normalisePlate } from "@/common/utils/plate.util";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { scoped, zoneScopeOf } from "@/common/rbac/scope";
import { QuoteService } from "@/modules/tariffs/quote.service";
import type {
  CancelSessionDto,
  EndSessionDto,
  SessionQueryDto,
  StartSessionDto,
} from "./dto/session.dto";

type Ctx = { ip?: string; requestId?: string; idempotencyKey?: string };

const SORTABLE = ["startAt", "endAt", "payableAmount", "status", "plateNumber"] as const;

const SESSION_SELECT = {
  id: true,
  code: true,
  clientEventId: true,
  zoneId: true,
  slotId: true,
  plateNumber: true,
  vehicleTypeId: true,
  vendorId: true,
  attendantId: true,
  shiftId: true,
  tariffId: true,
  status: true,
  source: true,
  startAt: true,
  endAt: true,
  durationMinutes: true,
  evidenceStartMediaId: true,
  evidenceEndMediaId: true,
  grossAmount: true,
  discountAmount: true,
  taxAmount: true,
  penaltyAmount: true,
  payableAmount: true,
  fareBreakdown: true,
  cancelledReason: true,
  createdAt: true,
  zone: { select: { id: true, code: true, name: true } },
  slot: { select: { id: true, code: true } },
  vehicleType: { select: { id: true, code: true, label: true } },
  vendor: { select: { id: true, orgName: true } },
  attendant: {
    select: { id: true, employeeCode: true, user: { select: { name: true } } },
  },
  /**
   * Just enough of the payment to answer "was this paid, and how".
   *
   * The full payment list is deliberately kept to the detail endpoint — a
   * listing has no use for gateway references — but the *absence* of any
   * payment state was worse than the weight of carrying it. The portal has a
   * required `paid` boolean and nothing to populate it from, so it asserted
   * `false`, and every completed session in the city rendered as unpaid with an
   * "Unpaid" figure on the screen to match. One captured row, two columns,
   * settles it.
   */
  payments: {
    where: { status: PaymentStatus.CAPTURED },
    select: { mode: true },
    take: 1,
  },
} satisfies Prisma.ParkingSessionSelect;

/**
 * The parking session: one vehicle, one stretch of kerb, one fare.
 *
 * Everything the platform earns begins here, so the rules are strict and the
 * server owns all of them. A device sends what it observed — a plate, a
 * photograph, a GPS fix — and this decides whether that is a valid session and
 * what it costs. No client computes a fare or picks its own zone.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly quotes: QuoteService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * The idempotency scope for a route, namespaced by the caller.
   *
   * Keys are chosen by clients, and two handsets will eventually pick the same
   * one. Without the user id in the scope, the second attendant's start would
   * be answered with the first attendant's session — a stranger's plate,
   * vehicle and location handed back as if it were theirs. The window is short
   * but the failure is not subtle.
   */
  private scope(route: string, user: AuthenticatedUser): string {
    return `session.${route}:${user.id}`;
  }

  private scopeFilter(user: AuthenticatedUser): Prisma.ParkingSessionWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) return { vendorId: user.vendorId };
    const zones = zoneScopeOf(user);
    return zones ? { zoneId: { in: zones } } : {};
  }

  private async config(key: string, fallback: number): Promise<number> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key } });
    const value = Number(row?.value ?? fallback);
    return Number.isFinite(value) ? value : fallback;
  }

  /**
   * A vehicle record per plate, created on first sight.
   *
   * The citizen who later claims the plate in the app inherits the history
   * rather than starting a new one, which is what makes "my parking history"
   * work for someone who has been parking for months before downloading it.
   */
  private async resolveVehicle(plate: string, vehicleTypeId: string, dto: StartSessionDto) {
    const existing = await this.prisma.vehicle.findUnique({ where: { plateNumber: plate } });
    if (existing) {
      if (existing.isBlacklisted) {
        throw new AppException(
          "FORBIDDEN",
          [{ field: "plateNumber", issue: "vehicle is blacklisted" }],
          "This vehicle is blacklisted. Refer to the zone officer before allowing it to park.",
        );
      }
      return existing;
    }

    return this.prisma.vehicle.create({
      data: {
        plateNumber: plate,
        vehicleTypeId,
        makeModel: dto.makeModel,
        colour: dto.colour,
      },
    });
  }

  async start(dto: StartSessionDto, user: AuthenticatedUser, ctx: Ctx) {
    // Replay of an offline event: answer with what was already recorded rather
    // than starting a second session for the same car.
    if (dto.clientEventId) {
      const replay = await this.prisma.parkingSession.findUnique({
        where: { clientEventId: dto.clientEventId },
        select: SESSION_SELECT,
      });
      if (replay) return { ...replay, replayed: true };

      // A device event id is stored on the session itself under a unique index,
      // so it protects the start permanently and atomically. Nothing the
      // idempotency store offers improves on that, and wrapping it would only
      // keep a redundant copy of the session for a day.
      return this.startOnce(dto, user, ctx);
    }

    // The portal and the citizen app send no device event id. An
    // `Idempotency-Key` header is how they get the same protection — best
    // effort rather than a database constraint, but it is what turns a retried
    // POST from a dropped connection into one session instead of two.
    if (!ctx.idempotencyKey) return this.startOnce(dto, user, ctx);

    const { value, replayed } = await this.idempotency.run(
      this.scope("start", user),
      ctx.idempotencyKey,
      () => this.startOnce(dto, user, ctx),
    );
    return { ...value, replayed };
  }

  private async startOnce(dto: StartSessionDto, user: AuthenticatedUser, ctx: Ctx) {
    const plate = normalisePlate(dto.plateNumber);
    if (!isValidPlate(plate)) {
      throw new AppException("VALIDATION_FAILED", [
        { field: "plateNumber", issue: "not a recognisable Indian registration number" },
      ]);
    }

    const zone = await this.prisma.zone.findUnique({
      where: { id: dto.zoneId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        capacity: true,
        boundary: true,
        centerLat: true,
        centerLng: true,
        allowedVehicleTypeIds: true,
        vendorZones: { where: { endedAt: null }, select: { vendorId: true } },
      },
    });
    if (!zone) throw AppException.notFound("zone");

    if (zone.status !== ZoneStatus.OPEN) {
      throw new AppException(
        "ZONE_CLOSED",
        [{ field: "zoneId", issue: `zone is ${zone.status}` }],
        "This zone is not open. No new sessions can be started here.",
      );
    }

    if (!zone.allowedVehicleTypeIds.includes(dto.vehicleType)) {
      throw new AppException("VEHICLE_TYPE_NOT_ALLOWED", [
        { field: "vehicleType", issue: `${dto.vehicleType} is not permitted in this zone` },
      ]);
    }

    // One live session per plate, anywhere. A car cannot be parked in two
    // places, so a second start is either a mistake or an attempt to charge
    // twice — both are worth refusing.
    const alreadyParked = await this.prisma.parkingSession.findFirst({
      where: {
        plateNumber: plate,
        status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] },
      },
      select: { id: true, code: true, zone: { select: { name: true } }, startAt: true },
    });
    if (alreadyParked) {
      throw new AppException(
        "SESSION_ALREADY_ACTIVE",
        [{ field: "plateNumber", issue: `already parked at ${alreadyParked.zone.name}` }],
        `${plate} already has a live session (${alreadyParked.code}). End that one first.`,
      );
    }

    const occupied = await this.prisma.parkingSession.count({
      where: { zoneId: zone.id, status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] } },
    });
    if (occupied >= zone.capacity) {
      throw new AppException(
        "ZONE_AT_CAPACITY",
        [{ field: "zoneId", issue: `${occupied} of ${zone.capacity} bays occupied` }],
        "This zone is full. Direct the driver to the nearest zone with space.",
      );
    }

    // Geo-fence. Checked only when the device sent a fix — a portal-entered
    // session has no handset location and is attributed to the operator instead.
    if (dto.location) {
      const tolerance = await this.config("ops.geofenceToleranceM", 25);
      const inside = withinZone(
        dto.location,
        zone.boundary as unknown as GeoPolygon | null,
        { lat: zone.centerLat, lng: zone.centerLng },
        tolerance,
      );
      if (!inside) {
        throw new AppException(
          "OUTSIDE_GEOFENCE",
          [{ field: "location", issue: "the device is not inside this zone" }],
          "You appear to be outside this zone. Move to the bay before starting the session.",
        );
      }
    }

    const vehicleType = await this.prisma.vehicleType.findUnique({
      where: { code: dto.vehicleType },
      select: { id: true },
    });
    if (!vehicleType) throw AppException.notFound("vehicle type");

    const vehicle = await this.resolveVehicle(plate, vehicleType.id, dto);

    // Who is accountable for this session and its cash.
    const attendant = user.attendantId
      ? await this.prisma.attendant.findUnique({
          where: { id: user.attendantId },
          select: { id: true, vendorId: true },
        })
      : null;

    const vendorId = attendant?.vendorId ?? zone.vendorZones[0]?.vendorId;
    if (!vendorId) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "zoneId", issue: "no vendor is assigned to this zone" }],
        "Assign an operator to this zone before sessions can be started in it.",
      );
    }

    const openShift = attendant
      ? await this.prisma.shift.findFirst({
          where: { attendantId: attendant.id, status: "OPEN" },
          select: { id: true },
        })
      : null;

    const startAt = dto.startedAt ?? new Date();

    const session = await this.prisma.$transaction(async (tx) => {
      const created = await tx.parkingSession.create({
        data: {
          code: generateSessionCode(),
          clientEventId: dto.clientEventId,
          zoneId: zone.id,
          slotId: dto.slotId,
          vehicleId: vehicle.id,
          plateNumber: plate,
          vehicleTypeId: vehicleType.id,
          vendorId,
          attendantId: attendant?.id,
          shiftId: openShift?.id,
          status: SessionStatus.ACTIVE,
          source: dto.source ?? (attendant ? SessionSource.ATTENDANT_APP : SessionSource.ADMIN_PORTAL),
          startAt,
          startLat: dto.location?.lat,
          startLng: dto.location?.lng,
          evidenceStartMediaId: dto.evidenceMediaId,
          syncedAt: dto.clientEventId ? new Date() : null,
        },
        select: SESSION_SELECT,
      });

      if (dto.slotId) {
        await tx.slot.update({ where: { id: dto.slotId }, data: { status: SlotStatus.OCCUPIED } });
      }
      if (openShift) {
        await tx.shift.update({
          where: { id: openShift.id },
          data: { sessionsCount: { increment: 1 } },
        });
      }

      return created;
    });

    await this.audit.record({
      actor: user,
      action: "SESSION_START",
      entity: "ParkingSession",
      entityId: session.id,
      after: { code: session.code, plateNumber: plate, zoneId: zone.id, startAt },
      ...ctx,
    });

    return { ...session, replayed: false };
  }

  /**
   * Ends a session and prices it.
   *
   * The fare is computed here, from the tariff that was live for this zone, and
   * written onto the session with its full breakdown. A receipt printed months
   * later shows the same lines because they were stored, not recomputed against
   * whatever the tariff has since become.
   */
  async end(id: string, dto: EndSessionDto, user: AuthenticatedUser, ctx: Ctx) {
    // `clientEventId` is the handset's own id for the end event. It was
    // accepted by the schema and then ignored, which made the offline queue's
    // promise — replay this as often as you like — true of starts and not of
    // ends. Either id serves as the key; the header covers the portal.
    const key = dto.clientEventId ?? ctx.idempotencyKey;
    if (!key) return this.endOnce(id, dto, user, ctx);

    const { value, replayed } = await this.idempotency.run(
      this.scope("end", user),
      key,
      () => this.endOnce(id, dto, user, ctx),
    );
    return { ...value, replayed };
  }

  private async endOnce(id: string, dto: EndSessionDto, user: AuthenticatedUser, ctx: Ctx) {
    const session = await this.prisma.parkingSession.findFirst({
      where: { OR: [{ id }, { code: id }] },
      select: {
        ...SESSION_SELECT,
        vehicleId: true,
        zone: { select: { id: true, code: true, name: true, boundary: true, centerLat: true, centerLng: true } },
      },
    });
    if (!session) throw AppException.notFound("session");

    if (session.status === SessionStatus.COMPLETED) {
      // Idempotent: an offline replay of an end must return the same fare, not
      // recompute one against a longer duration.
      return { ...session, replayed: true };
    }
    if (session.status !== SessionStatus.ACTIVE && session.status !== SessionStatus.OVERSTAY) {
      throw new AppException(
        "SESSION_NOT_ACTIVE",
        [{ field: "status", issue: `session is ${session.status}` }],
        "Only a live session can be ended.",
      );
    }

    const endAt = dto.endedAt ?? new Date();
    if (endAt < session.startAt) {
      throw new AppException("VALIDATION_FAILED", [
        { field: "endedAt", issue: "the session cannot end before it started" },
      ]);
    }

    const vehicleTypeRow = await this.prisma.vehicleType.findUnique({
      where: { id: session.vehicleTypeId },
      select: { code: true },
    });

    const overstayAfterMinutes = await this.config("ops.overstayAfterMinutes", 360);

    const quote = await this.quotes.quote({
      zoneId: session.zoneId,
      vehicleType: vehicleTypeRow!.code as SlotType,
      startAt: session.startAt,
      endAt,
      overstayAfterMinutes,
      vehicleId: session.vehicleId,
      discountCode: dto.discountCode,
    });

    // Taken from the quote, not recomputed. The fare engine rounds a part
    // minute up — you do not get a free thirty seconds — so computing it again
    // here with a different rule would store a duration that disagrees with the
    // amount charged, and leave a disputed fare impossible to reconcile.
    const durationMinutes = quote.durationMinutes;

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.parkingSession.update({
        where: { id: session.id },
        data: {
          status: SessionStatus.COMPLETED,
          endAt,
          durationMinutes,
          endLat: dto.location?.lat,
          endLng: dto.location?.lng,
          evidenceEndMediaId: dto.evidenceMediaId,
          tariffId: quote.tariffId,
          passId: quote.passId,
          grossAmount: quote.grossAmount,
          discountAmount: quote.discountAmount,
          taxAmount: quote.taxAmount,
          penaltyAmount: quote.penaltyAmount,
          payableAmount: quote.payableAmount,
          fareBreakdown: quote as unknown as Prisma.InputJsonValue,
        },
        select: SESSION_SELECT,
      });

      if (session.slotId) {
        await tx.slot.update({ where: { id: session.slotId }, data: { status: SlotStatus.AVAILABLE } });
      }

      return row;
    });

    await this.audit.record({
      actor: user,
      action: "SESSION_END",
      entity: "ParkingSession",
      entityId: session.id,
      before: { status: session.status },
      after: {
        status: SessionStatus.COMPLETED,
        durationMinutes,
        payableAmount: quote.payableAmount,
        tariffId: quote.tariffId,
      },
      ...ctx,
    });

    return { ...updated, quote, replayed: false };
  }

  async cancel(id: string, dto: CancelSessionDto, user: AuthenticatedUser, ctx: Ctx) {
    const session = await this.prisma.parkingSession.findFirst({
      where: { OR: [{ id }, { code: id }] },
      select: { id: true, code: true, status: true, slotId: true, plateNumber: true },
    });
    if (!session) throw AppException.notFound("session");

    if (session.status === SessionStatus.COMPLETED) {
      throw new AppException(
        "SESSION_NOT_ACTIVE",
        [{ field: "status", issue: "session is already completed" }],
        "A completed session cannot be cancelled. Refund the payment instead — that keeps the money trail intact.",
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.parkingSession.update({
        where: { id: session.id },
        data: {
          status: SessionStatus.CANCELLED,
          cancelledReason: dto.reason,
          endAt: new Date(),
          payableAmount: 0,
        },
        select: SESSION_SELECT,
      });
      if (session.slotId) {
        await tx.slot.update({ where: { id: session.slotId }, data: { status: SlotStatus.AVAILABLE } });
      }
      return row;
    });

    await this.audit.record({
      actor: user,
      action: "SESSION_CANCEL",
      entity: "ParkingSession",
      entityId: session.id,
      before: { status: session.status },
      after: { status: SessionStatus.CANCELLED, reason: dto.reason },
      ...ctx,
    });

    return updated;
  }

  async list(query: SessionQueryDto, user: AuthenticatedUser) {
    const overstayAfterMinutes = await this.config("ops.overstayAfterMinutes", 360);
    const overstayBefore = new Date(Date.now() - overstayAfterMinutes * 60_000);

    // The caller's filters go in their own object: a `?zoneId=` that landed in
    // the same literal as the scope used to overwrite it outright, and hand a
    // zone officer another ward's live sessions, registration numbers included.
    const where = scoped<Prisma.ParkingSessionWhereInput>(this.scopeFilter(user), {
      ...(query.status ? { status: query.status } : {}),
      ...(query.zoneId ? { zoneId: query.zoneId } : {}),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.attendantId ? { attendantId: query.attendantId } : {}),
      ...(query.vehicleType
        ? { vehicleType: { code: query.vehicleType } }
        : {}),
      ...(query.plateNumber ? { plateNumber: { contains: normalisePlate(query.plateNumber) } } : {}),
      ...(query.from || query.to
        ? { startAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(query.overstayOnly
        ? {
            status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] },
            startAt: { lt: overstayBefore },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: "insensitive" } },
              { plateNumber: { contains: normalisePlate(query.q) } },
            ],
          }
        : {}),
    });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.parkingSession.findMany({
        where,
        select: SESSION_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { startAt: "desc" }),
        ...skipTake(query),
      }),
      this.prisma.parkingSession.count({ where }),
    ]);

    // Live sessions carry a running duration and a provisional charge so the
    // portal does not have to know the grace period or the tariff.
    const now = Date.now();
    const items = rows.map((row) => ({
      ...row,
      elapsedMinutes:
        row.endAt === null ? Math.round((now - row.startAt.getTime()) / 60000) : row.durationMinutes,
      isOverstay:
        row.endAt === null && row.startAt.getTime() < overstayBefore.getTime(),
    }));

    return new Paginated(items, query.page, query.pageSize, total);
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const session = await this.prisma.parkingSession.findFirst({
      where: scoped<Prisma.ParkingSessionWhereInput>(this.scopeFilter(user), {
        OR: [{ id }, { code: id }],
      }),
      select: {
        ...SESSION_SELECT,
        payments: {
          select: { id: true, amount: true, mode: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
        incidents: { select: { id: true, type: true, status: true, createdAt: true } },
      },
    });
    if (!session) throw AppException.notFound("session");

    const overstayAfterMinutes = await this.config("ops.overstayAfterMinutes", 360);
    const elapsed =
      session.endAt === null
        ? Math.round((Date.now() - session.startAt.getTime()) / 60000)
        : session.durationMinutes;

    return {
      ...session,
      elapsedMinutes: elapsed,
      isOverstay: session.endAt === null && (elapsed ?? 0) > overstayAfterMinutes,
    };
  }

  /**
   * What is this vehicle doing right now, and what has it done before?
   *
   * The attendant's first action at the kerb: point at a plate and find out
   * whether to start a session or end one.
   */
  async lookupPlate(plateNumber: string, user: AuthenticatedUser) {
    const plate = normalisePlate(plateNumber);

    const [active, recent, vehicle] = await Promise.all([
      this.prisma.parkingSession.findFirst({
        where: { plateNumber: plate, status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] } },
        select: SESSION_SELECT,
      }),
      this.prisma.parkingSession.findMany({
        where: scoped<Prisma.ParkingSessionWhereInput>(this.scopeFilter(user), {
          plateNumber: plate,
          status: SessionStatus.COMPLETED,
        }),
        select: {
          id: true,
          code: true,
          startAt: true,
          endAt: true,
          payableAmount: true,
          zone: { select: { name: true } },
        },
        orderBy: { startAt: "desc" },
        take: 5,
      }),
      this.prisma.vehicle.findUnique({
        where: { plateNumber: plate },
        select: {
          id: true,
          plateNumber: true,
          makeModel: true,
          colour: true,
          isBlacklisted: true,
          vehicleType: { select: { code: true, label: true } },
        },
      }),
    ]);

    const overstayAfterMinutes = await this.config("ops.overstayAfterMinutes", 360);
    const elapsed = active ? Math.round((Date.now() - active.startAt.getTime()) / 60000) : null;

    return {
      plateNumber: plate,
      known: Boolean(vehicle),
      vehicle,
      active: active
        ? { ...active, elapsedMinutes: elapsed, isOverstay: (elapsed ?? 0) > overstayAfterMinutes }
        : null,
      recent,
    };
  }

  /** Live occupancy for the operations board. */
  async live(user: AuthenticatedUser) {
    const overstayAfterMinutes = await this.config("ops.overstayAfterMinutes", 360);
    const overstayBefore = new Date(Date.now() - overstayAfterMinutes * 60_000);
    const where = scoped<Prisma.ParkingSessionWhereInput>(this.scopeFilter(user), {
      status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] },
    });

    const [total, overstaying, byZone] = await Promise.all([
      this.prisma.parkingSession.count({ where }),
      this.prisma.parkingSession.count({ where: { ...where, startAt: { lt: overstayBefore } } }),
      this.prisma.parkingSession.groupBy({
        by: ["zoneId"],
        where,
        _count: { _all: true },
      }),
    ]);

    return {
      activeSessions: total,
      overstaying,
      overstayAfterMinutes,
      byZone: byZone.map((z) => ({ zoneId: z.zoneId, count: z._count._all })),
    };
  }

  /**
   * Promotes long-running sessions to OVERSTAY.
   *
   * Overstay is derived from elapsed time, so a read can always work it out —
   * but a stored status is what lets the operations board filter on it, and
   * what an enforcement report is run against. Called on a schedule and safe to
   * run as often as you like.
   */
  async markOverstays(): Promise<number> {
    const overstayAfterMinutes = await this.config("ops.overstayAfterMinutes", 360);
    const cutoff = new Date(Date.now() - overstayAfterMinutes * 60_000);

    const { count } = await this.prisma.parkingSession.updateMany({
      where: { status: SessionStatus.ACTIVE, startAt: { lt: cutoff } },
      data: { status: SessionStatus.OVERSTAY },
    });

    if (count > 0) this.logger.log(`Marked ${count} session(s) as overstay`);
    return count;
  }
}
