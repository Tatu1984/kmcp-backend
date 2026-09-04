import { Injectable } from "@nestjs/common";
import { Prisma, SessionStatus, SlotStatus } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { scoped, zoneScopeOf } from "@/common/rbac/scope";
import type {
  BulkCreateSlotsDto,
  CreateSlotDto,
  SlotQueryDto,
  SlotStatusDto,
  UpdateSlotDto,
} from "./dto/slot.dto";

type Ctx = { ip?: string; requestId?: string };

const SORTABLE = ["code", "type", "status"] as const;

const SLOT_SELECT = {
  id: true,
  zoneId: true,
  code: true,
  type: true,
  status: true,
  isReserved: true,
  zone: { select: { id: true, code: true, name: true } },
} satisfies Prisma.SlotSelect;

/**
 * Individual bays within a zone.
 *
 * A zone's `capacity` is what the pricing and availability logic runs on; slots
 * are the physical inventory beneath it, used for bay-level status (a bay dug up
 * for works, a bay reserved for a permit holder) and for the occupancy view.
 */
@Injectable()
export class SlotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private scopeFilter(user: AuthenticatedUser): Prisma.SlotWhereInput {
    const zones = zoneScopeOf(user);
    return zones ? { zoneId: { in: zones } } : {};
  }

  /** The same scope, expressed against the zone itself rather than its bays. */
  private zoneScopeFilter(user: AuthenticatedUser): Prisma.ZoneWhereInput {
    const zones = zoneScopeOf(user);
    return zones ? { id: { in: zones } } : {};
  }

  /**
   * Resolves the zone, within what this caller may see.
   *
   * Scoped, because the zone row itself is the answer to a question. The
   * summary clamped its counts to the officer's own zones and then returned
   * another zone's code, name and capacity above them — so the officer learned
   * that a zone exists, what it is called and how big it is, and read their own
   * numbers under its name.
   */
  private async assertZone(zoneId: string, user: AuthenticatedUser) {
    const zone = await this.prisma.zone.findFirst({
      where: scoped<Prisma.ZoneWhereInput>(this.zoneScopeFilter(user), { id: zoneId }),
      select: { id: true, code: true, name: true, capacity: true },
    });
    if (!zone) throw AppException.notFound("zone");
    return zone;
  }

  async list(query: SlotQueryDto, user: AuthenticatedUser) {
    const where = scoped<Prisma.SlotWhereInput>(this.scopeFilter(user), {
      ...(query.zoneId ? { zoneId: query.zoneId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.isReserved !== undefined ? { isReserved: query.isReserved } : {}),
      ...(query.q ? { code: { contains: query.q, mode: "insensitive" } } : {}),
    });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.slot.findMany({
        where,
        select: SLOT_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { code: "asc" }),
        ...skipTake(query),
      }),
      this.prisma.slot.count({ where }),
    ]);

    return new Paginated(rows, query.page, query.pageSize, total);
  }

  /** Bay counts by status and type — what the zone detail screen draws. */
  async summary(zoneId: string, user: AuthenticatedUser) {
    const zone = await this.assertZone(zoneId, user);
    const where = scoped<Prisma.SlotWhereInput>(this.scopeFilter(user), { zoneId });

    const [byStatus, byType, total, activeSessions] = await Promise.all([
      this.prisma.slot.groupBy({ by: ["status"], where, _count: { _all: true } }),
      this.prisma.slot.groupBy({ by: ["type"], where, _count: { _all: true } }),
      this.prisma.slot.count({ where }),
      this.prisma.parkingSession.count({
        where: { zoneId, status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] } },
      }),
    ]);

    return {
      zone,
      total,
      // Bays mapped is not the same as capacity: a zone can be priced for 40
      // vehicles while only 12 bays have been painted and recorded.
      mappedAgainstCapacity: { mapped: total, capacity: zone.capacity },
      activeSessions,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      byType: byType.map((t) => ({ type: t.type, count: t._count._all })),
    };
  }

  async create(dto: CreateSlotDto, user: AuthenticatedUser, ctx: Ctx) {
    await this.assertZone(dto.zoneId, user);

    const clash = await this.prisma.slot.findUnique({
      where: { zoneId_code: { zoneId: dto.zoneId, code: dto.code } },
    });
    if (clash) {
      throw new AppException("DUPLICATE_RESOURCE", [
        { field: "code", issue: "a bay with this code already exists in the zone" },
      ]);
    }

    const slot = await this.prisma.slot.create({ data: dto, select: SLOT_SELECT });

    await this.audit.record({
      actor: user,
      action: "SLOT_CREATE",
      entity: "Slot",
      entityId: slot.id,
      after: { zoneId: slot.zoneId, code: slot.code, type: slot.type },
      ...ctx,
    });

    return slot;
  }

  /**
   * Creates a numbered run, skipping codes that already exist so the call can be
   * repeated safely after a partial failure.
   */
  async bulkCreate(dto: BulkCreateSlotsDto, user: AuthenticatedUser, ctx: Ctx) {
    const zone = await this.assertZone(dto.zoneId, user);

    const codes: string[] = [];
    for (let n = dto.from; n <= dto.to; n += 1) {
      codes.push(`${dto.prefix}${String(n).padStart(dto.pad, "0")}`);
    }

    const existing = await this.prisma.slot.findMany({
      where: { zoneId: dto.zoneId, code: { in: codes } },
      select: { code: true },
    });
    const taken = new Set(existing.map((s) => s.code));
    const fresh = codes.filter((code) => !taken.has(code));

    if (fresh.length > 0) {
      await this.prisma.slot.createMany({
        data: fresh.map((code) => ({
          zoneId: dto.zoneId,
          code,
          type: dto.type,
          isReserved: dto.isReserved,
        })),
      });
    }

    await this.audit.record({
      actor: user,
      action: "SLOT_BULK_CREATE",
      entity: "Zone",
      entityId: dto.zoneId,
      after: { range: `${codes[0]}–${codes[codes.length - 1]}`, created: fresh.length, skipped: taken.size },
      ...ctx,
    });

    return {
      zone,
      requested: codes.length,
      created: fresh.length,
      skippedExisting: [...taken].sort(),
    };
  }

  async update(id: string, dto: UpdateSlotDto, user: AuthenticatedUser, ctx: Ctx) {
    const before = await this.prisma.slot.findUnique({ where: { id }, select: SLOT_SELECT });
    if (!before) throw AppException.notFound("slot");

    const after = await this.prisma.slot.update({ where: { id }, data: dto, select: SLOT_SELECT });

    await this.audit.record({
      actor: user,
      action: "SLOT_UPDATE",
      entity: "Slot",
      entityId: id,
      before,
      after,
      ...ctx,
    });

    return after;
  }

  /**
   * Bay status is an operational fact, not a booking. Taking a bay out of
   * service while a vehicle is parked in it is refused — end the session first,
   * otherwise the fare has nowhere to land.
   */
  async changeStatus(id: string, dto: SlotStatusDto, user: AuthenticatedUser, ctx: Ctx) {
    const slot = await this.prisma.slot.findUnique({ where: { id }, select: SLOT_SELECT });
    if (!slot) throw AppException.notFound("slot");

    if (dto.status === SlotStatus.OUT_OF_SERVICE) {
      const occupied = await this.prisma.parkingSession.count({
        where: { slotId: id, status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] } },
      });
      if (occupied > 0) {
        throw new AppException(
          "SESSION_ALREADY_ACTIVE",
          [{ field: "status", issue: "a vehicle is currently parked in this bay" }],
          "End the parking session before taking this bay out of service.",
        );
      }
    }

    const after = await this.prisma.slot.update({
      where: { id },
      data: { status: dto.status },
      select: SLOT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "SLOT_STATUS_CHANGE",
      entity: "Slot",
      entityId: id,
      before: { status: slot.status },
      after: { status: dto.status, reason: dto.reason },
      ...ctx,
    });

    return after;
  }

  async remove(id: string, user: AuthenticatedUser, ctx: Ctx) {
    const slot = await this.prisma.slot.findUnique({
      where: { id },
      include: { _count: { select: { sessions: true } } },
    });
    if (!slot) throw AppException.notFound("slot");

    // A bay that has ever held a session is history: retire it, never delete it.
    if (slot._count.sessions > 0) {
      const after = await this.prisma.slot.update({
        where: { id },
        data: { status: SlotStatus.OUT_OF_SERVICE },
        select: SLOT_SELECT,
      });
      await this.audit.record({
        actor: user,
        action: "SLOT_RETIRE",
        entity: "Slot",
        entityId: id,
        before: { status: slot.status },
        after: { status: SlotStatus.OUT_OF_SERVICE, reason: "has session history" },
        ...ctx,
      });
      return { retired: true, deleted: false, slot: after };
    }

    await this.prisma.slot.delete({ where: { id } });
    await this.audit.record({
      actor: user,
      action: "SLOT_DELETE",
      entity: "Slot",
      entityId: id,
      before: { zoneId: slot.zoneId, code: slot.code },
      ...ctx,
    });

    return { retired: false, deleted: true, id };
  }
}
