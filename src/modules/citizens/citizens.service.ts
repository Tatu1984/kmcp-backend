import { Injectable, Logger } from "@nestjs/common";
import { PassStatus, PaymentStatus, Prisma, UserStatus } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import { SYSTEM_ROLES } from "@/common/rbac/permissions";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type { CitizenQueryDto, CitizenStatusDto, VehicleBlacklistDto } from "./dto/citizen.dto";

type Ctx = { ip?: string; requestId?: string };

const SORTABLE = ["createdAt", "lastLoginAt", "name", "status"] as const;

const CAPTURED: PaymentStatus[] = [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED];

/**
 * Citizens — the people who park, as distinct from the staff who run the place.
 *
 * A citizen is a User holding the CITIZEN role. Their parking history is not
 * reached through a column on the session: sessions belong to a *plate*, and a
 * plate belongs to a citizen only once they claim it in the app. Everything
 * counted here therefore goes through `vehicle.ownerUserId`, which is also why
 * someone who has been parking for months before downloading the app inherits
 * that history rather than starting empty.
 */
@Injectable()
export class CitizensService {
  private readonly logger = new Logger(CitizensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private baseWhere(query?: CitizenQueryDto): Prisma.UserWhereInput {
    return {
      role: SYSTEM_ROLES.CITIZEN,
      deletedAt: null,
      ...(query?.status ? { status: query.status } : {}),
      ...(query?.from || query?.to
        ? {
            createdAt: {
              ...(query?.from ? { gte: query.from } : {}),
              ...(query?.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query?.withPass
        ? { passes: { some: { status: PassStatus.ACTIVE, validTo: { gte: new Date() } } } }
        : {}),
      ...(query?.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { phone: { contains: query.q } },
              { email: { contains: query.q, mode: "insensitive" } },
              { vehicles: { some: { plateNumber: { contains: query.q.toUpperCase() } } } },
            ],
          }
        : {}),
    };
  }

  async list(query: CitizenQueryDto) {
    const where = this.baseWhere(query);

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          _count: { select: { vehicles: true } },
        },
        orderBy: orderBy(query.sort, SORTABLE, { createdAt: "desc" }),
        ...skipTake(query),
      }),
      this.prisma.user.count({ where }),
    ]);

    return new Paginated(await this.decorate(users), query.page, query.pageSize, total);
  }

  /**
   * Adds session count, lifetime spend and whether a live pass is held.
   *
   * Three grouped queries for the whole page rather than three per row — at a
   * few hundred citizens a per-row version would be a few hundred round trips
   * to Neon for one screen.
   */
  private async decorate(
    users: {
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      status: UserStatus;
      createdAt: Date;
      lastLoginAt: Date | null;
      _count: { vehicles: number };
    }[],
  ) {
    if (users.length === 0) return [];
    const ids = users.map((u) => u.id);

    const [vehicles, passes] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { ownerUserId: { in: ids } },
        select: { id: true, ownerUserId: true },
      }),
      this.prisma.pass.groupBy({
        by: ["userId"],
        where: { userId: { in: ids }, status: PassStatus.ACTIVE, validTo: { gte: new Date() } },
        _count: { _all: true },
      }),
    ]);

    const vehicleIds = vehicles.map((v) => v.id);
    const ownerByVehicle = new Map(vehicles.map((v) => [v.id, v.ownerUserId]));

    const [sessionCounts, payments] = await Promise.all([
      vehicleIds.length
        ? this.prisma.parkingSession.groupBy({
            by: ["vehicleId"],
            where: { vehicleId: { in: vehicleIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      vehicleIds.length
        ? this.prisma.payment.findMany({
            where: {
              status: { in: CAPTURED },
              OR: [
                { session: { vehicleId: { in: vehicleIds } } },
                { paidByUserId: { in: ids } },
              ],
            },
            select: {
              amount: true,
              refundedAmount: true,
              paidByUserId: true,
              session: { select: { vehicleId: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const sessionsByUser = new Map<string, number>();
    for (const row of sessionCounts) {
      const owner = ownerByVehicle.get(row.vehicleId);
      if (owner) sessionsByUser.set(owner, (sessionsByUser.get(owner) ?? 0) + row._count._all);
    }

    const spentByUser = new Map<string, number>();
    for (const payment of payments) {
      // Prefer whoever actually paid; fall back to whoever owns the vehicle.
      const owner =
        payment.paidByUserId ??
        (payment.session ? ownerByVehicle.get(payment.session.vehicleId) : undefined);
      if (!owner) continue;
      // Net of refunds — money returned was never really spent.
      const net = payment.amount - payment.refundedAmount;
      spentByUser.set(owner, (spentByUser.get(owner) ?? 0) + net);
    }

    const passByUser = new Map(passes.map((p) => [p.userId, p._count._all]));

    return users.map((user) => ({
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      status: user.status,
      vehicleCount: user._count.vehicles,
      sessionsCount: sessionsByUser.get(user.id) ?? 0,
      totalSpent: spentByUser.get(user.id) ?? 0,
      hasActivePass: (passByUser.get(user.id) ?? 0) > 0,
      joinedAt: user.createdAt,
      lastSeenAt: user.lastLoginAt,
    }));
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, role: SYSTEM_ROLES.CITIZEN, deletedAt: null },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
        _count: { select: { vehicles: true } },
      },
    });
    if (!user) throw AppException.notFound("citizen");

    const [decorated] = await this.decorate([user]);

    const vehicles = await this.prisma.vehicle.findMany({
      where: { ownerUserId: id },
      select: {
        id: true,
        plateNumber: true,
        makeModel: true,
        colour: true,
        isBlacklisted: true,
        vehicleType: { select: { id: true, code: true, label: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const sessions = await this.prisma.parkingSession.findMany({
      where: { vehicle: { ownerUserId: id } },
      select: {
        id: true,
        code: true,
        plateNumber: true,
        status: true,
        startAt: true,
        endAt: true,
        payableAmount: true,
        zone: { select: { id: true, name: true } },
      },
      orderBy: { startAt: "desc" },
      take: 20,
    });

    const passes = await this.prisma.pass.findMany({
      where: { userId: id },
      select: {
        id: true,
        qrCode: true,
        validFrom: true,
        validTo: true,
        status: true,
        plan: { select: { name: true, price: true } },
      },
      orderBy: { validTo: "desc" },
      take: 10,
    });

    return { ...decorated, vehicles, sessions, passes };
  }

  async summary() {
    const now = new Date();
    const [byStatus, withPass, vehicles] = await Promise.all([
      this.prisma.user.groupBy({
        by: ["status"],
        where: { role: SYSTEM_ROLES.CITIZEN, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.user.count({
        where: {
          role: SYSTEM_ROLES.CITIZEN,
          deletedAt: null,
          passes: { some: { status: PassStatus.ACTIVE, validTo: { gte: now } } },
        },
      }),
      this.prisma.vehicle.count({ where: { ownerUserId: { not: null } } }),
    ]);

    const count = (status: UserStatus) => byStatus.find((s) => s.status === status)?._count._all ?? 0;

    return {
      total: byStatus.reduce((s, r) => s + r._count._all, 0),
      active: count(UserStatus.ACTIVE),
      suspended: count(UserStatus.SUSPENDED),
      blacklisted: count(UserStatus.BLACKLISTED),
      withActivePass: withPass,
      claimedVehicles: vehicles,
    };
  }

  /**
   * Change a citizen's account status.
   *
   * Note what this does *not* do: it leaves their vehicles alone. Enforcement
   * at the kerb reads `vehicle.isBlacklisted`, because an attendant types a
   * plate and has no idea who owns it — so blocking the account and blocking
   * the vehicle are two separate acts, and doing one silently as a side effect
   * of the other would either under-enforce or wrongly clear a plate that was
   * blacklisted for its own reasons.
   */
  async setStatus(id: string, dto: CitizenStatusDto, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.prisma.user.findFirst({
      where: { id, role: SYSTEM_ROLES.CITIZEN, deletedAt: null },
      select: { id: true, name: true, status: true },
    });
    if (!current) throw AppException.notFound("citizen");

    if (current.status === dto.status) return this.findOne(id);

    await this.prisma.user.update({ where: { id }, data: { status: dto.status } });

    // Blocking an account has to end the sessions it is already signed in to,
    // or the ban does not take effect until the access token happens to expire.
    if (dto.status !== UserStatus.ACTIVE) {
      await this.prisma.loginSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.audit.record({
      actor: user,
      action: "CITIZEN_STATUS_CHANGE",
      entity: "User",
      entityId: id,
      before: { status: current.status },
      after: { status: dto.status, reason: dto.reason },
      ...ctx,
    });

    return this.findOne(id);
  }

  /** Blacklist or clear one of a citizen's vehicles — the check the kerb makes. */
  async setVehicleBlacklist(
    id: string,
    vehicleId: string,
    dto: VehicleBlacklistDto,
    user: AuthenticatedUser,
    ctx: Ctx,
  ) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, ownerUserId: id },
      select: { id: true, plateNumber: true, isBlacklisted: true },
    });
    if (!vehicle) throw AppException.notFound("vehicle");

    if (vehicle.isBlacklisted === dto.isBlacklisted) return this.findOne(id);

    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { isBlacklisted: dto.isBlacklisted },
    });

    await this.audit.record({
      actor: user,
      action: dto.isBlacklisted ? "VEHICLE_BLACKLIST" : "VEHICLE_BLACKLIST_CLEAR",
      entity: "Vehicle",
      entityId: vehicleId,
      before: { isBlacklisted: vehicle.isBlacklisted },
      after: { isBlacklisted: dto.isBlacklisted, plateNumber: vehicle.plateNumber, reason: dto.reason },
      ...ctx,
    });

    return this.findOne(id);
  }
}
