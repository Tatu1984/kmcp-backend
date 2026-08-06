import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { PrismaService } from "@/prisma/prisma.service";
import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import { RequirePermissions } from "@/common/decorators/auth.decorators";
import { AppException } from "@/common/errors/app.exception";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { PaginationSchema, skipTake } from "@/common/dto/pagination.dto";

const AuditQuerySchema = PaginationSchema.extend({
  action: z.string().max(64).optional(),
  entity: z.string().max(64).optional(),
  entityId: z.string().max(64).optional(),
  actorUserId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
type AuditQueryDto = z.infer<typeof AuditQuerySchema>;

/**
 * The business-mutation trail: who changed what, and what it looked like before
 * and after. Sign-in activity lives under /activity, which carries the network
 * and device context this one does not.
 *
 * Append-only — there is deliberately no write or delete endpoint here, not
 * even for a Super Admin.
 */
@ApiTags("Audit")
@ApiBearerAuth("bearer")
@Controller("audit")
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @RequirePermissions("audit.read")
  @Get("logs")
  @ApiOperation({ summary: "Every recorded change, newest first" })
  async logs(@Query(zodPipe(AuditQuerySchema)) query: AuditQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { action: { contains: query.q, mode: "insensitive" } },
              { entity: { contains: query.q, mode: "insensitive" } },
              { entityId: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(query) }),
      this.prisma.auditLog.count({ where }),
    ]);

    // Resolve actor names in one query rather than a join per row.
    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter(Boolean))] as string[];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true, role: true },
        })
      : [];
    const byId = new Map(actors.map((a) => [a.id, a]));

    return new Paginated(
      rows.map((row) => ({ ...row, actor: row.actorUserId ? (byId.get(row.actorUserId) ?? null) : null })),
      query.page,
      query.pageSize,
      total,
    );
  }

  @RequirePermissions("audit.read")
  @Get("logs/:id")
  @ApiOperation({ summary: "One entry with its full before and after" })
  async entry(@Param("id") id: string) {
    const row = await this.prisma.auditLog.findUnique({ where: { id } });
    if (!row) throw AppException.notFound("audit entry");

    const actor = row.actorUserId
      ? await this.prisma.user.findUnique({
          where: { id: row.actorUserId },
          select: { id: true, name: true, email: true, role: true },
        })
      : null;

    return { ...row, actor };
  }

  @RequirePermissions("audit.read")
  @Get("entities/:entity/:entityId")
  @ApiOperation({
    summary: "Everything that ever happened to one record",
    description: "The history an auditor asks for when they question a single zone or settlement.",
  })
  history(@Param("entity") entity: string, @Param("entityId") entityId: string) {
    return this.prisma.auditLog.findMany({
      where: { entity, entityId },
      orderBy: { createdAt: "desc" },
    });
  }

  @RequirePermissions("audit.read")
  @Get("summary")
  @ApiOperation({ summary: "Counts by action and by actor, for the audit dashboard" })
  async summary() {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [total, thisWeek, byAction, byEntity] = await Promise.all([
      this.prisma.auditLog.count(),
      this.prisma.auditLog.count({ where: { createdAt: { gte: weekAgo } } }),
      this.prisma.auditLog.groupBy({
        by: ["action"],
        _count: { _all: true },
        orderBy: { _count: { action: "desc" } },
        take: 15,
      }),
      this.prisma.auditLog.groupBy({
        by: ["entity"],
        _count: { _all: true },
        orderBy: { _count: { entity: "desc" } },
      }),
    ]);

    return {
      total,
      thisWeek,
      byAction: byAction.map((a) => ({ action: a.action, count: a._count._all })),
      byEntity: byEntity.map((e) => ({ entity: e.entity, count: e._count._all })),
    };
  }

  @RequirePermissions("audit.read")
  @Get("sync")
  @ApiOperation({
    summary: "Offline replay batches from the vendor app",
    description: "Event counts, how many were accepted, and how many hit a conflict.",
  })
  async sync(@Query(zodPipe(PaginationSchema)) query: AuditQueryDto) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.syncLog.findMany({ orderBy: { createdAt: "desc" }, ...skipTake(query) }),
      this.prisma.syncLog.count(),
    ]);
    return new Paginated(items, query.page, query.pageSize, total);
  }

  @RequirePermissions("audit.read")
  @Get("devices")
  @ApiOperation({ summary: "Registered devices and when they were last seen" })
  async devices(@Query(zodPipe(PaginationSchema)) query: AuditQueryDto) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.device.findMany({
        orderBy: { lastSeenAt: "desc" },
        include: { user: { select: { id: true, name: true, role: true } } },
        ...skipTake(query),
      }),
      this.prisma.device.count(),
    ]);
    return new Paginated(rows, query.page, query.pageSize, total);
  }
}
