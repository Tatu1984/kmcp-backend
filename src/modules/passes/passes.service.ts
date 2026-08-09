import { Injectable, Logger } from "@nestjs/common";
import { PassStatus, Prisma } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type {
  CancelPassDto,
  CreatePassPlanDto,
  PassPlanQueryDto,
  PassQueryDto,
  UpdatePassPlanDto,
} from "./dto/pass.dto";

type Ctx = { ip?: string; requestId?: string };

const PASS_SORTABLE = ["validTo", "validFrom", "createdAt", "status"] as const;

const PASS_SELECT = {
  id: true,
  userId: true,
  vehicleId: true,
  planId: true,
  qrCode: true,
  validFrom: true,
  validTo: true,
  status: true,
  createdAt: true,
  user: { select: { id: true, name: true, phone: true, email: true } },
  vehicle: {
    select: {
      id: true,
      plateNumber: true,
      vehicleType: { select: { id: true, code: true, label: true } },
    },
  },
  plan: {
    select: { id: true, name: true, price: true, durationDays: true, zoneIds: true },
  },
} satisfies Prisma.PassSelect;

/**
 * Monthly passes and the plans they are sold from.
 *
 * A plan is a price card; a pass is one citizen's entitlement against one
 * vehicle. The split matters because a plan's price can change while every
 * pass already sold keeps the terms it was bought on — which is why a pass
 * carries its own validity dates rather than deriving them from the plan.
 */
@Injectable()
export class PassesService {
  private readonly logger = new Logger(PassesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ plans

  async listPlans(query: PassPlanQueryDto) {
    const where: Prisma.PassPlanWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.vehicleTypeId ? { vehicleTypeId: query.vehicleTypeId } : {}),
      ...(query.q ? { name: { contains: query.q, mode: "insensitive" } } : {}),
    };

    const [plans, total] = await this.prisma.$transaction([
      this.prisma.passPlan.findMany({ where, orderBy: [{ name: "asc" }], ...skipTake(query) }),
      this.prisma.passPlan.count({ where }),
    ]);

    return new Paginated(await this.decoratePlans(plans), query.page, query.pageSize, total);
  }

  /**
   * Adds the two things a plan card shows that the row does not hold: how many
   * passes are live against it, and what its zone scope is called.
   */
  private async decoratePlans(plans: { id: string; vehicleTypeId: string; zoneIds: string[] }[]) {
    if (plans.length === 0) return [];

    const zoneIds = [...new Set(plans.flatMap((p) => p.zoneIds))];
    const [counts, vehicleTypes, zones] = await Promise.all([
      this.prisma.pass.groupBy({
        by: ["planId"],
        where: { planId: { in: plans.map((p) => p.id) }, status: PassStatus.ACTIVE },
        _count: { _all: true },
      }),
      this.prisma.vehicleType.findMany({
        where: { id: { in: [...new Set(plans.map((p) => p.vehicleTypeId))] } },
        select: { id: true, code: true, label: true },
      }),
      zoneIds.length
        ? this.prisma.zone.findMany({
            where: { id: { in: zoneIds } },
            select: { id: true, code: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const countByPlan = new Map(counts.map((c) => [c.planId, c._count._all]));
    const typeById = new Map(vehicleTypes.map((v) => [v.id, v]));
    const zoneById = new Map(zones.map((z) => [z.id, z]));

    return plans.map((plan) => {
      const scoped = plan.zoneIds.map((id) => zoneById.get(id)).filter(Boolean);
      return {
        ...plan,
        activePasses: countByPlan.get(plan.id) ?? 0,
        vehicleType: typeById.get(plan.vehicleTypeId) ?? null,
        zones: scoped,
        zoneScope:
          plan.zoneIds.length === 0
            ? "All zones"
            : scoped.length === 1
              ? (scoped[0]?.name ?? "1 zone")
              : `${plan.zoneIds.length} zones`,
      };
    });
  }

  async findPlan(id: string) {
    const plan = await this.prisma.passPlan.findUnique({ where: { id } });
    if (!plan) throw AppException.notFound("pass plan");
    const [decorated] = await this.decoratePlans([plan]);
    return decorated;
  }

  async createPlan(dto: CreatePassPlanDto, user: AuthenticatedUser, ctx: Ctx) {
    await this.assertPlanReferences(dto.vehicleTypeId, dto.zoneIds);

    const plan = await this.prisma.passPlan.create({
      data: {
        name: dto.name,
        vehicleTypeId: dto.vehicleTypeId,
        zoneIds: dto.zoneIds,
        durationDays: dto.durationDays,
        price: dto.price,
        isActive: dto.isActive,
      },
    });

    await this.audit.record({
      actor: user,
      action: "PASS_PLAN_CREATE",
      entity: "PassPlan",
      entityId: plan.id,
      after: { name: plan.name, price: plan.price, durationDays: plan.durationDays },
      ...ctx,
    });

    const [decorated] = await this.decoratePlans([plan]);
    return decorated;
  }

  async updatePlan(id: string, dto: UpdatePassPlanDto, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.prisma.passPlan.findUnique({ where: { id } });
    if (!current) throw AppException.notFound("pass plan");

    if (dto.vehicleTypeId !== undefined || dto.zoneIds !== undefined) {
      await this.assertPlanReferences(
        dto.vehicleTypeId ?? current.vehicleTypeId,
        dto.zoneIds ?? current.zoneIds,
      );
    }

    // A price or duration change applies to what is sold next, never to a pass
    // already issued — those carry their own dates and were paid for at the
    // old price. Nothing here touches the Pass table, and that is deliberate.
    const plan = await this.prisma.passPlan.update({ where: { id }, data: dto });

    await this.audit.record({
      actor: user,
      action: "PASS_PLAN_UPDATE",
      entity: "PassPlan",
      entityId: id,
      before: current,
      after: plan,
      ...ctx,
    });

    const [decorated] = await this.decoratePlans([plan]);
    return decorated;
  }

  /**
   * Plans are withdrawn from sale, never deleted.
   *
   * Passes point at the plan they were bought from, and a citizen holding a
   * live pass must still be able to see what they paid for.
   */
  async setPlanActive(id: string, isActive: boolean, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.prisma.passPlan.findUnique({ where: { id } });
    if (!current) throw AppException.notFound("pass plan");
    if (current.isActive === isActive) {
      const [unchanged] = await this.decoratePlans([current]);
      return unchanged;
    }

    const plan = await this.prisma.passPlan.update({ where: { id }, data: { isActive } });

    await this.audit.record({
      actor: user,
      action: isActive ? "PASS_PLAN_RESUME" : "PASS_PLAN_WITHDRAW",
      entity: "PassPlan",
      entityId: id,
      before: { isActive: current.isActive },
      after: { isActive },
      ...ctx,
    });

    const [decorated] = await this.decoratePlans([plan]);
    return decorated;
  }

  private async assertPlanReferences(vehicleTypeId: string, zoneIds: string[]): Promise<void> {
    const vehicleType = await this.prisma.vehicleType.findUnique({
      where: { id: vehicleTypeId },
      select: { id: true },
    });
    if (!vehicleType) throw AppException.notFound("vehicle type");

    if (zoneIds.length > 0) {
      const found = await this.prisma.zone.count({ where: { id: { in: zoneIds } } });
      if (found !== new Set(zoneIds).size) {
        throw new AppException("VALIDATION_FAILED", [
          { field: "zoneIds", issue: "one or more zones do not exist" },
        ]);
      }
    }
  }

  // ----------------------------------------------------------------- passes

  async listPasses(query: PassQueryDto) {
    const where: Prisma.PassWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.planId ? { planId: query.planId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.vehicleId ? { vehicleId: query.vehicleId } : {}),
      ...(query.expiringInDays
        ? {
            status: PassStatus.ACTIVE,
            validTo: {
              gte: new Date(),
              lte: new Date(Date.now() + query.expiringInDays * 24 * 60 * 60 * 1000),
            },
          }
        : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { qrCode: { contains: query.q, mode: "insensitive" } },
              { user: { name: { contains: query.q, mode: "insensitive" } } },
              { user: { phone: { contains: query.q } } },
              { vehicle: { plateNumber: { contains: query.q.toUpperCase() } } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.pass.findMany({
        where,
        select: PASS_SELECT,
        orderBy: orderBy(query.sort, PASS_SORTABLE, { validTo: "desc" }),
        ...skipTake(query),
      }),
      this.prisma.pass.count({ where }),
    ]);

    return new Paginated(items, query.page, query.pageSize, total);
  }

  async findPass(id: string) {
    const pass = await this.prisma.pass.findUnique({ where: { id }, select: PASS_SELECT });
    if (!pass) throw AppException.notFound("pass");
    return pass;
  }

  /** Counts the screen's stat cards need, over every pass rather than a page. */
  async passSummary() {
    const now = new Date();
    const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [byStatus, expiringSoon, revenue] = await Promise.all([
      this.prisma.pass.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.pass.count({
        where: { status: PassStatus.ACTIVE, validTo: { gte: now, lte: inSevenDays } },
      }),
      this.prisma.pass.findMany({
        where: { status: { in: [PassStatus.ACTIVE, PassStatus.EXPIRED] } },
        select: { plan: { select: { price: true } } },
      }),
    ]);

    const count = (status: PassStatus) => byStatus.find((s) => s.status === status)?._count._all ?? 0;

    return {
      total: byStatus.reduce((s, r) => s + r._count._all, 0),
      active: count(PassStatus.ACTIVE),
      expired: count(PassStatus.EXPIRED),
      cancelled: count(PassStatus.CANCELLED),
      pendingPayment: count(PassStatus.PENDING_PAYMENT),
      expiringSoon,
      // What passes have brought in, at the price each was actually sold for.
      revenue: revenue.reduce((s, p) => s + p.plan.price, 0),
    };
  }

  /**
   * Cancel a pass.
   *
   * An expired pass is left alone: it already ended on its own terms, and
   * rewriting it as cancelled would misrepresent why it stopped working.
   */
  async cancelPass(id: string, dto: CancelPassDto, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.prisma.pass.findUnique({
      where: { id },
      select: { id: true, qrCode: true, status: true },
    });
    if (!current) throw AppException.notFound("pass");

    if (current.status !== PassStatus.ACTIVE && current.status !== PassStatus.PENDING_PAYMENT) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "status", issue: `pass is ${current.status.toLowerCase()}` }],
        `${current.qrCode} is not active, so there is nothing to cancel.`,
      );
    }

    const pass = await this.prisma.pass.update({
      where: { id },
      data: { status: PassStatus.CANCELLED },
      select: PASS_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "PASS_CANCEL",
      entity: "Pass",
      entityId: id,
      before: { status: current.status },
      after: { status: pass.status, reason: dto.reason },
      ...ctx,
    });

    return pass;
  }
}
