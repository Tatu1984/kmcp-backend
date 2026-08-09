import { Injectable, Logger } from "@nestjs/common";
import { IncidentStatus, Prisma } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import { SYSTEM_ROLES } from "@/common/rbac/permissions";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type {
  AssignIncidentDto,
  CreateIncidentDto,
  IncidentQueryDto,
  RejectIncidentDto,
  ResolveIncidentDto,
} from "./dto/incident.dto";

type Ctx = { ip?: string; requestId?: string };

const SORTABLE = ["createdAt", "resolvedAt", "status", "type"] as const;

const INCIDENT_SELECT = {
  id: true,
  reportedById: true,
  sessionId: true,
  zoneId: true,
  type: true,
  description: true,
  mediaIds: true,
  status: true,
  assignedTo: true,
  resolutionNote: true,
  resolvedBy: true,
  resolvedAt: true,
  createdAt: true,
  session: { select: { id: true, code: true, plateNumber: true, zoneId: true, vendorId: true } },
} satisfies Prisma.IncidentSelect;

type IncidentRow = Prisma.IncidentGetPayload<{ select: typeof INCIDENT_SELECT }>;

/** Statuses from which an incident can still be worked. */
const OPEN_STATUSES: IncidentStatus[] = [IncidentStatus.OPEN, IncidentStatus.IN_PROGRESS];

/**
 * Incidents raised at the kerb — illegal parking, damage, a dispute over a bay.
 *
 * The model stores who reported it, who it is assigned to and who resolved it
 * as bare user ids rather than relations, because a reporter can be an
 * attendant, a citizen or a portal user. Names are therefore resolved after the
 * page is fetched, in one lookup, rather than through a join that cannot be
 * expressed.
 *
 * Nothing here deletes. An incident that turns out to be nonsense is rejected
 * with a reason and stays on the record — a complaint answered months later is
 * answered from this table.
 */
@Injectable()
export class IncidentsService {
  private readonly logger = new Logger(IncidentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A human-facing reference.
   *
   * Derived from the id rather than stored, so there is no counter to race on
   * and no migration to add a column that would only ever mirror the key. The
   * suffix of a cuid is already unique, which is all a reference has to be.
   */
  private reference(id: string): string {
    return `INC-${id.slice(-6).toUpperCase()}`;
  }

  private async scopeFilter(user: AuthenticatedUser): Promise<Prisma.IncidentWhereInput> {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) {
      // A vendor sees what happened on their sessions and in the zones they
      // operate. An incident logged against a zone carries no vendor id of its
      // own, so the zones have to be looked up.
      const zones = await this.prisma.vendorZone.findMany({
        where: { vendorId: user.vendorId },
        select: { zoneId: true },
      });
      const zoneIds = zones.map((z) => z.zoneId);
      return {
        OR: [{ session: { vendorId: user.vendorId } }, ...(zoneIds.length ? [{ zoneId: { in: zoneIds } }] : [])],
      };
    }
    if (user.isZoneScoped && user.zoneIds.length > 0) {
      return {
        OR: [{ zoneId: { in: user.zoneIds } }, { session: { zoneId: { in: user.zoneIds } } }],
      };
    }
    return {};
  }

  /**
   * Attaches the names the screens show.
   *
   * Two queries for a page of any size rather than one per row — the ids come
   * from three different columns that all point at User, so they are gathered
   * and resolved together.
   */
  private async hydrate(rows: IncidentRow[]) {
    const userIds = new Set<string>();
    const zoneIds = new Set<string>();
    for (const row of rows) {
      userIds.add(row.reportedById);
      if (row.assignedTo) userIds.add(row.assignedTo);
      if (row.resolvedBy) userIds.add(row.resolvedBy);
      const zoneId = row.zoneId ?? row.session?.zoneId;
      if (zoneId) zoneIds.add(zoneId);
    }

    const [users, zones] = await Promise.all([
      userIds.size
        ? this.prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, name: true, role: true },
          })
        : Promise.resolve([]),
      zoneIds.size
        ? this.prisma.zone.findMany({
            where: { id: { in: [...zoneIds] } },
            select: { id: true, code: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const userById = new Map(users.map((u) => [u.id, u]));
    const zoneById = new Map(zones.map((z) => [z.id, z]));

    return rows.map((row) => {
      const reporter = userById.get(row.reportedById);
      const zone = zoneById.get(row.zoneId ?? row.session?.zoneId ?? "");
      return {
        ...row,
        reference: this.reference(row.id),
        reportedBy: reporter ? { id: reporter.id, name: reporter.name, role: reporter.role } : null,
        assignedToUser: row.assignedTo
          ? { id: row.assignedTo, name: userById.get(row.assignedTo)?.name ?? "—" }
          : null,
        resolvedByUser: row.resolvedBy
          ? { id: row.resolvedBy, name: userById.get(row.resolvedBy)?.name ?? "—" }
          : null,
        zone: zone ?? null,
        photoCount: row.mediaIds.length,
      };
    });
  }

  private async require(id: string, user: AuthenticatedUser): Promise<IncidentRow> {
    const scope = await this.scopeFilter(user);
    const incident = await this.prisma.incident.findFirst({
      where: { id, ...scope },
      select: INCIDENT_SELECT,
    });
    if (!incident) throw AppException.notFound("incident");
    return incident;
  }

  async list(query: IncidentQueryDto, user: AuthenticatedUser) {
    const scope = await this.scopeFilter(user);
    const where: Prisma.IncidentWhereInput = {
      ...scope,
      ...(query.status ? { status: query.status } : {}),
      ...(query.openOnly ? { status: { in: OPEN_STATUSES } } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.zoneId ? { zoneId: query.zoneId } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.assignedTo ? { assignedTo: query.assignedTo } : {}),
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
              { description: { contains: query.q, mode: "insensitive" } },
              { session: { code: { contains: query.q, mode: "insensitive" } } },
              { session: { plateNumber: { contains: query.q.toUpperCase() } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.incident.findMany({
        where,
        select: INCIDENT_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { createdAt: "desc" }),
        ...skipTake(query),
      }),
      this.prisma.incident.count({ where }),
    ]);

    return new Paginated(await this.hydrate(rows), query.page, query.pageSize, total);
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const incident = await this.require(id, user);
    const [hydrated] = await this.hydrate([incident]);
    return hydrated;
  }

  /** Counts a duty officer's dashboard needs, within whatever they may see. */
  async summary(user: AuthenticatedUser) {
    const scope = await this.scopeFilter(user);
    const [byStatus, byType] = await Promise.all([
      this.prisma.incident.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
      this.prisma.incident.groupBy({ by: ["type"], where: scope, _count: { _all: true } }),
    ]);

    const count = (status: IncidentStatus) =>
      byStatus.find((s) => s.status === status)?._count._all ?? 0;

    return {
      total: byStatus.reduce((s, r) => s + r._count._all, 0),
      open: count(IncidentStatus.OPEN),
      inProgress: count(IncidentStatus.IN_PROGRESS),
      resolved: count(IncidentStatus.RESOLVED),
      rejected: count(IncidentStatus.REJECTED),
      byType: byType.map((t) => ({ type: t.type, count: t._count._all })),
    };
  }

  async create(dto: CreateIncidentDto, user: AuthenticatedUser, ctx: Ctx) {
    // Resolve the zone from the session when only a session was given, so the
    // zone filter on the list screen works for both kinds of report.
    let zoneId = dto.zoneId ?? null;
    if (dto.sessionId) {
      const session = await this.prisma.parkingSession.findUnique({
        where: { id: dto.sessionId },
        select: { id: true, zoneId: true },
      });
      if (!session) throw AppException.notFound("session");
      zoneId ??= session.zoneId;
    }

    if (zoneId) {
      const zone = await this.prisma.zone.findUnique({ where: { id: zoneId }, select: { id: true } });
      if (!zone) throw AppException.notFound("zone");
    }

    const incident = await this.prisma.incident.create({
      data: {
        reportedById: user.id,
        sessionId: dto.sessionId ?? null,
        zoneId,
        type: dto.type,
        description: dto.description,
        mediaIds: dto.mediaIds,
        status: IncidentStatus.OPEN,
      },
      select: INCIDENT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "INCIDENT_CREATE",
      entity: "Incident",
      entityId: incident.id,
      after: { type: dto.type, zoneId, sessionId: dto.sessionId ?? null },
      ...ctx,
    });

    const [hydrated] = await this.hydrate([incident]);
    return hydrated;
  }

  async assign(id: string, dto: AssignIncidentDto, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.require(id, user);
    this.refuseIfClosed(current, "assigned");

    const assignee = await this.prisma.user.findUnique({
      where: { id: dto.assignedTo },
      select: { id: true, name: true, status: true },
    });
    if (!assignee) throw AppException.notFound("user");

    const incident = await this.prisma.incident.update({
      where: { id },
      data: {
        assignedTo: dto.assignedTo,
        // Assigning is what moves it off the unattended pile.
        status: IncidentStatus.IN_PROGRESS,
      },
      select: INCIDENT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "INCIDENT_ASSIGN",
      entity: "Incident",
      entityId: id,
      before: { assignedTo: current.assignedTo, status: current.status },
      after: { assignedTo: dto.assignedTo, status: incident.status, note: dto.note },
      ...ctx,
    });

    const [hydrated] = await this.hydrate([incident]);
    return hydrated;
  }

  /**
   * Pick an incident up without naming someone else.
   *
   * Assignment and starting work are separate acts: a duty officer often takes
   * a report themselves before anyone decides who owns it. Unassigned
   * incidents fall to the caller, so "in progress" always has a name against
   * it rather than becoming a status nobody is accountable for.
   */
  async start(id: string, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.require(id, user);
    this.refuseIfClosed(current, "started");

    if (current.status === IncidentStatus.IN_PROGRESS) return this.findOne(id, user);

    const incident = await this.prisma.incident.update({
      where: { id },
      data: {
        status: IncidentStatus.IN_PROGRESS,
        assignedTo: current.assignedTo ?? user.id,
      },
      select: INCIDENT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "INCIDENT_START",
      entity: "Incident",
      entityId: id,
      before: { status: current.status, assignedTo: current.assignedTo },
      after: { status: incident.status, assignedTo: incident.assignedTo },
      ...ctx,
    });

    const [hydrated] = await this.hydrate([incident]);
    return hydrated;
  }

  async resolve(id: string, dto: ResolveIncidentDto, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.require(id, user);
    this.refuseIfClosed(current, "resolved");

    const incident = await this.prisma.incident.update({
      where: { id },
      data: {
        status: IncidentStatus.RESOLVED,
        resolutionNote: dto.resolutionNote,
        resolvedBy: user.id,
        resolvedAt: new Date(),
      },
      select: INCIDENT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "INCIDENT_RESOLVE",
      entity: "Incident",
      entityId: id,
      before: { status: current.status },
      after: { status: incident.status, resolutionNote: dto.resolutionNote },
      ...ctx,
    });

    const [hydrated] = await this.hydrate([incident]);
    return hydrated;
  }

  async reject(id: string, dto: RejectIncidentDto, user: AuthenticatedUser, ctx: Ctx) {
    const current = await this.require(id, user);
    this.refuseIfClosed(current, "rejected");

    const incident = await this.prisma.incident.update({
      where: { id },
      data: {
        status: IncidentStatus.REJECTED,
        // The reason lands in the same column a resolution would, because to
        // everyone reading the record later it answers the same question:
        // what happened to this report?
        resolutionNote: dto.reason,
        resolvedBy: user.id,
        resolvedAt: new Date(),
      },
      select: INCIDENT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "INCIDENT_REJECT",
      entity: "Incident",
      entityId: id,
      before: { status: current.status },
      after: { status: incident.status, reason: dto.reason },
      ...ctx,
    });

    const [hydrated] = await this.hydrate([incident]);
    return hydrated;
  }

  /**
   * A closed incident stays closed.
   *
   * Reopening by overwriting would lose who resolved it and when, which is
   * exactly what an audit of a disputed incident needs. A fresh report is the
   * right way to raise it again.
   */
  private refuseIfClosed(incident: IncidentRow, verb: string): void {
    if (!OPEN_STATUSES.includes(incident.status)) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "status", issue: `already ${incident.status.toLowerCase()}` }],
        `${this.reference(incident.id)} was already closed and cannot be ${verb}. Raise a new incident instead.`,
      );
    }
  }
}
