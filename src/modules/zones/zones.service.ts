import { Injectable } from "@nestjs/common";
import { Prisma, SessionStatus, SlotStatus, ZoneStatus } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import { boundingBox, distanceMetres, withinZone, type GeoPolygon } from "@/common/utils/geo.util";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { scoped, zoneScopeOf } from "@/common/rbac/scope";
import type {
  CreateZoneDto,
  NearbyDto,
  UpdateZoneDto,
  ZoneQueryDto,
  ZoneStatusDto,
} from "./dto/zone.dto";

const SORTABLE = ["code", "name", "capacity", "createdAt", "status"] as const;

const ZONE_SELECT = {
  id: true,
  code: true,
  name: true,
  wardId: true,
  streetId: true,
  centerLat: true,
  centerLng: true,
  boundary: true,
  capacity: true,
  allowedVehicleTypeIds: true,
  openTime: true,
  closeTime: true,
  status: true,
  closureReason: true,
  closureUntil: true,
  createdAt: true,
  updatedAt: true,
  ward: { select: { id: true, code: true, name: true } },
  street: { select: { id: true, name: true } },
  /**
   * The operator currently holding the kerb.
   *
   * Its absence was a silent one-way street: `POST /zones/:id/vendor` and
   * `POST /vendors/:id/zones` both wrote the assignment correctly, and no read
   * ever returned it — so the portal showed every zone as unassigned however
   * many times an officer assigned one. The write looked like it had failed
   * when it had not.
   *
   * `endedAt: null` because `VendorZone` is a history: a zone that changed
   * hands keeps the closed row, and only the open one is the answer to "who
   * operates this today".
   */
  vendorZones: {
    where: { endedAt: null },
    select: { vendor: { select: { id: true, orgName: true } } },
    take: 1,
  },
} satisfies Prisma.ZoneSelect;

/** Flattens the assignment row into the `vendor` the clients read. */
function withVendor<T extends { vendorZones?: { vendor: { id: string; orgName: string } }[] }>(
  zone: T,
): Omit<T, "vendorZones"> & { vendor: { id: string; orgName: string } | null } {
  const { vendorZones, ...rest } = zone;
  return { ...rest, vendor: vendorZones?.[0]?.vendor ?? null };
}

@Injectable()
export class ZonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Zone-scoped roles only ever see the kerb they are assigned. Applied at the
   * query, not filtered afterwards, so a scoped caller cannot page past it.
   */
  private scopeFilter(user: AuthenticatedUser): Prisma.ZoneWhereInput {
    const zones = zoneScopeOf(user);
    return zones ? { id: { in: zones } } : {};
  }

  private async withOccupancy<T extends { id: string; capacity: number }>(zones: T[]) {
    if (zones.length === 0) return [];
    const counts = await this.prisma.parkingSession.groupBy({
      by: ["zoneId"],
      where: {
        zoneId: { in: zones.map((z) => z.id) },
        status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] },
      },
      _count: { _all: true },
    });
    const byZone = new Map(counts.map((c) => [c.zoneId, c._count._all]));
    return zones.map((zone) => {
      const occupied = byZone.get(zone.id) ?? 0;
      const available = Math.max(0, zone.capacity - occupied);
      // Destructured rather than passed through `withVendor` so the caller's
      // own row type survives the spread.
      const { vendorZones, ...rest } = zone as T & {
        vendorZones?: { vendor: { id: string; orgName: string } }[];
      };
      return {
        ...rest,
        vendor: vendorZones?.[0]?.vendor ?? null,
        occupied,
        available,
        occupancyPct: zone.capacity > 0 ? Math.round((occupied / zone.capacity) * 100) : 0,
        availability: available === 0 ? "FULL" : available <= zone.capacity * 0.3 ? "LIMITED" : "AVAILABLE",
      };
    });
  }

  async list(query: ZoneQueryDto, user: AuthenticatedUser) {
    const where = scoped<Prisma.ZoneWhereInput>(this.scopeFilter(user), {
      ...(query.status ? { status: query.status } : {}),
      ...(query.wardId ? { wardId: query.wardId } : {}),
      ...(query.vendorId
        ? { vendorZones: { some: { vendorId: query.vendorId, endedAt: null } } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: "insensitive" } },
              { name: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.zone.findMany({
        where,
        select: ZONE_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { code: "asc" }),
        ...skipTake(query),
      }),
      this.prisma.zone.count({ where }),
    ]);

    const enriched = await this.withOccupancy(rows);
    const items = query.availableOnly ? enriched.filter((z) => z.available > 0) : enriched;
    return new Paginated(items, query.page, query.pageSize, total);
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const zone = await this.prisma.zone.findFirst({
      where: scoped<Prisma.ZoneWhereInput>(this.scopeFilter(user), { id }),
      select: {
        ...ZONE_SELECT,
        _count: { select: { slots: true, sessions: true } },
        vendorZones: {
          where: { endedAt: null },
          select: { vendor: { select: { id: true, orgName: true, commissionPct: true, status: true } } },
        },
      },
    });
    if (!zone) throw AppException.notFound("zone");

    const [enriched] = await this.withOccupancy([zone]);
    return { ...enriched, vendor: zone.vendorZones[0]?.vendor ?? null };
  }

  async create(dto: CreateZoneDto, user: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    const existing = await this.prisma.zone.findUnique({ where: { code: dto.code } });
    if (existing) {
      throw new AppException("DUPLICATE_RESOURCE", [{ field: "code", issue: "already in use" }]);
    }

    const zone = await this.prisma.$transaction(async (tx) => {
      const created = await tx.zone.create({
        data: {
          code: dto.code,
          name: dto.name,
          wardId: dto.wardId,
          streetId: dto.streetId,
          centerLat: dto.centerLat,
          centerLng: dto.centerLng,
          boundary: (dto.boundary ?? Prisma.JsonNull) as never,
          capacity: dto.capacity,
          allowedVehicleTypeIds: dto.allowedVehicleTypeIds,
          openTime: dto.openTime,
          closeTime: dto.closeTime,
        },
        select: ZONE_SELECT,
      });

      if (!dto.vendorId) return created;

      // Re-read once the assignment exists. Returning `created` here reported
      // the zone as unassigned in the same response that assigned it.
      await tx.vendorZone.create({ data: { vendorId: dto.vendorId, zoneId: created.id } });
      return tx.zone.findUniqueOrThrow({ where: { id: created.id }, select: ZONE_SELECT });
    });

    await this.audit.record({
      actor: user,
      action: "ZONE_CREATE",
      entity: "Zone",
      entityId: zone.id,
      after: { code: zone.code, name: zone.name, capacity: zone.capacity },
      ...ctx,
    });

    return withVendor(zone);
  }

  async update(
    id: string,
    dto: UpdateZoneDto,
    user: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const before = await this.prisma.zone.findUnique({ where: { id }, select: ZONE_SELECT });
    if (!before) throw AppException.notFound("zone");

    const { vendorId, boundary, ...rest } = dto;
    await this.prisma.zone.update({
      where: { id },
      data: {
        ...rest,
        ...(boundary !== undefined ? { boundary: boundary as never } : {}),
      },
      select: { id: true },
    });

    // Assign before re-reading, or the response reports the operator the zone
    // had a moment ago rather than the one it now has.
    if (vendorId) await this.assignVendor(id, vendorId, user, ctx);

    const after = await this.prisma.zone.findUniqueOrThrow({
      where: { id },
      select: ZONE_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "ZONE_UPDATE",
      entity: "Zone",
      entityId: id,
      before,
      after,
      ...ctx,
    });

    return withVendor(after);
  }

  async changeStatus(
    id: string,
    dto: ZoneStatusDto,
    user: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const before = await this.prisma.zone.findUnique({
      where: { id },
      select: { status: true, closureReason: true, name: true },
    });
    if (!before) throw AppException.notFound("zone");

    const zone = await this.prisma.zone.update({
      where: { id },
      data: {
        status: dto.status,
        closureReason: dto.status === ZoneStatus.OPEN ? null : (dto.reason ?? null),
        closureUntil: dto.status === ZoneStatus.OPEN ? null : (dto.until ?? null),
      },
      select: ZONE_SELECT,
    });

    // Vehicles already parked keep their sessions and are charged normally —
    // only new sessions are blocked.
    const activeNow = await this.prisma.parkingSession.count({
      where: { zoneId: id, status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] } },
    });

    await this.audit.record({
      actor: user,
      action: "ZONE_STATUS_CHANGE",
      entity: "Zone",
      entityId: id,
      before,
      after: { status: dto.status, reason: dto.reason },
      ...ctx,
    });

    return { ...zone, activeSessionsUnaffected: activeNow };
  }

  async assignVendor(
    zoneId: string,
    vendorId: string,
    user: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw AppException.notFound("vendor");
    if (vendor.status !== "APPROVED") {
      throw new AppException("FORBIDDEN", undefined, "Only approved vendors can be assigned kerb.");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.vendorZone.updateMany({
        where: { zoneId, endedAt: null },
        data: { endedAt: new Date() },
      });
      await tx.vendorZone.upsert({
        where: { vendorId_zoneId: { vendorId, zoneId } },
        create: { vendorId, zoneId },
        update: { endedAt: null, assignedAt: new Date() },
      });
    });

    await this.audit.record({
      actor: user,
      action: "ZONE_VENDOR_ASSIGN",
      entity: "Zone",
      entityId: zoneId,
      after: { vendorId, vendorName: vendor.orgName },
      ...ctx,
    });

    return { zoneId, vendorId, vendorName: vendor.orgName };
  }

  async occupancy(id: string) {
    const zone = await this.prisma.zone.findUnique({
      where: { id },
      select: { id: true, code: true, name: true, capacity: true, status: true },
    });
    if (!zone) throw AppException.notFound("zone");

    const [byType, slotCounts, enriched] = await Promise.all([
      this.prisma.parkingSession.groupBy({
        by: ["vehicleTypeId"],
        where: { zoneId: id, status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] } },
        _count: { _all: true },
      }),
      this.prisma.slot.groupBy({
        by: ["status"],
        where: { zoneId: id },
        _count: { _all: true },
      }),
      this.withOccupancy([zone]),
    ]);

    return {
      ...enriched[0],
      byVehicleType: byType.map((t) => ({ vehicleTypeId: t.vehicleTypeId, count: t._count._all })),
      slots: slotCounts.map((s) => ({ status: s.status, count: s._count._all })),
    };
  }

  /**
   * Public discovery for the citizen app. Pre-filters on a bounding box so the
   * database does the cheap work, then sorts by exact great-circle distance.
   */
  async nearby(dto: NearbyDto) {
    const box = boundingBox({ lat: dto.lat, lng: dto.lng }, dto.radius);

    const zones = await this.prisma.zone.findMany({
      where: {
        status: ZoneStatus.OPEN,
        centerLat: { gte: box.minLat, lte: box.maxLat },
        centerLng: { gte: box.minLng, lte: box.maxLng },
        ...(dto.vehicleType ? { allowedVehicleTypeIds: { has: dto.vehicleType } } : {}),
      },
      select: {
        id: true,
        code: true,
        name: true,
        centerLat: true,
        centerLng: true,
        capacity: true,
        openTime: true,
        closeTime: true,
        allowedVehicleTypeIds: true,
        ward: { select: { name: true } },
        street: { select: { name: true } },
      },
      take: 200,
    });

    const enriched = await this.withOccupancy(zones);

    return enriched
      .map((zone) => ({
        ...zone,
        distanceMetres: distanceMetres(
          { lat: dto.lat, lng: dto.lng },
          { lat: zone.centerLat, lng: zone.centerLng },
        ),
      }))
      .filter((z) => z.distanceMetres <= dto.radius)
      .sort((a, b) => a.distanceMetres - b.distanceMetres)
      .slice(0, dto.limit);
  }

  /**
   * Which zone is this attendant standing in? The device sends raw coordinates
   * and the server decides — a phone never picks its own zone.
   */
  async resolveByLocation(lat: number, lng: number, user: AuthenticatedUser) {
    const candidates = await this.prisma.zone.findMany({
      where: scoped<Prisma.ZoneWhereInput>(this.scopeFilter(user), { status: ZoneStatus.OPEN }),
      select: {
        id: true,
        code: true,
        name: true,
        centerLat: true,
        centerLng: true,
        boundary: true,
        capacity: true,
        allowedVehicleTypeIds: true,
        openTime: true,
        closeTime: true,
      },
    });

    const tolerance = await this.geofenceTolerance();
    const matches = candidates
      .filter((zone) =>
        withinZone(
          { lat, lng },
          zone.boundary as unknown as GeoPolygon | null,
          { lat: zone.centerLat, lng: zone.centerLng },
          tolerance,
        ),
      )
      .map((zone) => ({
        ...zone,
        distanceMetres: distanceMetres({ lat, lng }, { lat: zone.centerLat, lng: zone.centerLng }),
      }))
      .sort((a, b) => a.distanceMetres - b.distanceMetres);

    if (matches.length === 0) throw new AppException("OUTSIDE_GEOFENCE");

    const [enriched] = await this.withOccupancy([matches[0]]);
    return { ...enriched, alternatives: matches.slice(1, 4).map((m) => ({ id: m.id, code: m.code, name: m.name })) };
  }

  /** Configurable because street-level GPS accuracy varies by city and handset. */
  async geofenceTolerance(): Promise<number> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key: "ops.geofenceToleranceM" } });
    const value = Number(row?.value ?? 25);
    return Number.isFinite(value) ? value : 25;
  }

  async heatmap(user: AuthenticatedUser) {
    const zones = await this.prisma.zone.findMany({
      where: this.scopeFilter(user),
      select: {
        id: true,
        code: true,
        name: true,
        capacity: true,
        centerLat: true,
        centerLng: true,
        status: true,
        ward: { select: { name: true } },
      },
    });
    return this.withOccupancy(zones);
  }

  async remove(id: string, reason: string, user: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    const zone = await this.prisma.zone.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
    if (!zone) throw AppException.notFound("zone");

    // Nothing is deleted — history has to stay explainable. The zone is
    // withdrawn from service and released from its vendor.
    await this.prisma.$transaction(async (tx) => {
      await tx.zone.update({
        where: { id },
        data: { status: ZoneStatus.CLOSED, closureReason: reason },
      });
      await tx.vendorZone.updateMany({ where: { zoneId: id, endedAt: null }, data: { endedAt: new Date() } });
      await tx.slot.updateMany({ where: { zoneId: id }, data: { status: SlotStatus.OUT_OF_SERVICE } });
    });

    await this.audit.record({
      actor: user,
      action: "ZONE_RETIRE",
      entity: "Zone",
      entityId: id,
      before: zone,
      after: { status: ZoneStatus.CLOSED, reason },
      ...ctx,
    });

    return { retired: true, id, reason };
  }
}
