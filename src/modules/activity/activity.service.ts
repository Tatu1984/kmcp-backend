import { Injectable } from "@nestjs/common";
import { AuthEventType, LocationConsentStatus, Prisma } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { AuthEventService } from "./auth-event.service";
import type { ActivityQueryDto, ApproveEventDto, ConsentDto } from "./dto/activity.dto";

@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AuthEventService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- overview

  async overview() {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      signInsToday,
      failuresToday,
      flaggedWeek,
      liveSessions,
      distinctIps,
      topCities,
      riskiest,
    ] = await Promise.all([
      this.prisma.authEvent.count({
        where: { eventType: AuthEventType.LOGIN_SUCCESS, createdAt: { gte: dayAgo } },
      }),
      this.prisma.authEvent.count({
        where: { eventType: AuthEventType.LOGIN_FAILED, createdAt: { gte: dayAgo } },
      }),
      this.prisma.authEvent.count({
        where: { riskScore: { gt: 0 }, createdAt: { gte: weekAgo } },
      }),
      this.prisma.loginSession.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
      this.prisma.authEvent.findMany({
        where: { createdAt: { gte: weekAgo }, ipAddress: { not: null } },
        distinct: ["ipAddress"],
        select: { ipAddress: true },
      }),
      this.prisma.authEvent.groupBy({
        by: ["city"],
        where: { createdAt: { gte: weekAgo }, city: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { city: "desc" } },
        take: 8,
      }),
      this.prisma.authEvent.findMany({
        where: { createdAt: { gte: weekAgo }, riskScore: { gte: 35 } },
        orderBy: [{ riskScore: "desc" }, { createdAt: "desc" }],
        take: 10,
      }),
    ]);

    return {
      window: { since: weekAgo.toISOString(), now: now.toISOString() },
      signInsToday,
      failuresToday,
      flaggedThisWeek: flaggedWeek,
      liveSessions,
      distinctIpsThisWeek: distinctIps.length,
      topCities: topCities.map((c) => ({ city: c.city, count: c._count._all })),
      riskiest,
    };
  }

  // ------------------------------------------------------------------ events

  async events_(query: ActivityQueryDto) {
    const where: Prisma.AuthEventWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.ip ? { ipAddress: query.ip } : {}),
      ...(query.city ? { city: { contains: query.city, mode: "insensitive" } } : {}),
      ...(query.flaggedOnly ? { riskScore: { gt: 0 } } : {}),
      ...(query.minRisk !== undefined ? { riskScore: { gte: query.minRisk } } : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { userName: { contains: query.q, mode: "insensitive" } },
              { identifierTried: { contains: query.q, mode: "insensitive" } },
              { ipAddress: { contains: query.q } },
              { city: { contains: query.q, mode: "insensitive" } },
              { isp: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.authEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...skipTake(query),
      }),
      this.prisma.authEvent.count({ where }),
    ]);

    // Mark which rows are already on the trust allowlist so the feed can hide
    // approved places without an N+1 lookup per row.
    const userIds = [...new Set(items.map((i) => i.userId).filter(Boolean))] as string[];
    const trusted = userIds.length
      ? await this.prisma.trustedLoginLocation.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, ipAddress: true },
        })
      : [];
    const trustedKeys = new Set(trusted.map((t) => `${t.userId}|${t.ipAddress}`));

    return new Paginated(
      items.map((event) => ({
        ...event,
        isTrusted: trustedKeys.has(`${event.userId}|${event.ipAddress}`),
      })),
      query.page,
      query.pageSize,
      total,
    );
  }

  /** Everything this account has done recently — the "who is this person" view. */
  async timeline(userId: string, limit = 100) {
    const [user, events, sessions, devices] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, phone: true, role: true, status: true, lastLoginAt: true },
      }),
      this.prisma.authEvent.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      this.prisma.loginSession.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
      this.prisma.device.findMany({ where: { userId }, orderBy: { lastSeenAt: "desc" } }),
    ]);

    if (!user) throw AppException.notFound("user");

    const places = await this.prisma.authEvent.groupBy({
      by: ["city", "country"],
      where: { userId, eventType: AuthEventType.LOGIN_SUCCESS, city: { not: null } },
      _count: { _all: true },
      _max: { createdAt: true },
    });

    return {
      user,
      events,
      sessions,
      devices,
      places: places
        .map((p) => ({
          city: p.city,
          country: p.country,
          logins: p._count._all,
          lastSeen: p._max.createdAt,
        }))
        .sort((a, b) => b.logins - a.logins),
    };
  }

  // ---------------------------------------------------------------- sessions

  async liveSessions() {
    const now = new Date();
    const sessions = await this.prisma.loginSession.findMany({
      where: { revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: "desc" },
      take: 200,
    });

    // Flag accounts holding more than one live session — the shape that
    // account-sharing takes.
    const byUser = new Map<string, number>();
    sessions.forEach((s) => byUser.set(s.userId, (byUser.get(s.userId) ?? 0) + 1));

    return sessions.map((s) => ({
      ...s,
      concurrentForUser: byUser.get(s.userId) ?? 1,
    }));
  }

  async revokeSession(
    sessionId: string,
    reason: string,
    actor: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const session = await this.prisma.loginSession.findUnique({ where: { sessionId } });
    if (!session) throw AppException.notFound("session");

    await this.events.closeSession(sessionId, reason);
    await this.events.record({
      eventType: AuthEventType.SESSION_REVOKED,
      userId: session.userId,
      userName: session.userName,
      sessionId,
      failureReason: reason,
      context: {
        ip: session.ipAddress ?? "",
        geo: { source: "unknown" },
        device: { fingerprint: session.deviceFingerprint ?? "" },
      },
    });
    await this.audit.record({
      actor,
      action: "SESSION_REVOKE",
      entity: "LoginSession",
      entityId: sessionId,
      after: { reason, userId: session.userId },
      ...ctx,
    });

    return { revoked: true, sessionId };
  }

  // ------------------------------------------------------------------- trust

  /** Approving a flagged sign-in allowlists its (user, IP) so it stops flagging. */
  async approve(
    eventId: string,
    dto: ApproveEventDto,
    actor: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const event = await this.prisma.authEvent.findUnique({ where: { id: eventId } });
    if (!event) throw AppException.notFound("sign-in event");
    if (!event.userId || !event.ipAddress) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "event", issue: "has no user or IP to approve" }],
        "This event cannot be approved — it has no account or address to trust.",
      );
    }

    const snapshot = {
      userName: event.userName,
      city: event.city,
      region: event.region,
      country: event.country,
      asn: event.asn,
      isp: event.isp,
      label: dto.label ?? null,
      approvedBy: actor.id,
      approvedByName: actor.name,
    };

    const trusted = await this.prisma.trustedLoginLocation.upsert({
      where: { userId_ipAddress: { userId: event.userId, ipAddress: event.ipAddress } },
      create: { userId: event.userId, ipAddress: event.ipAddress, ...snapshot },
      update: { ...snapshot, lastSeenAt: new Date() },
    });

    await this.audit.record({
      actor,
      action: "LOGIN_LOCATION_TRUST",
      entity: "TrustedLoginLocation",
      entityId: trusted.id,
      after: { userId: event.userId, ip: event.ipAddress, city: event.city, label: dto.label },
      ...ctx,
    });

    return trusted;
  }

  listTrusted() {
    return this.prisma.trustedLoginLocation.findMany({ orderBy: { lastSeenAt: "desc" } });
  }

  async revokeTrust(id: string, actor: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    const removed = await this.prisma.trustedLoginLocation.delete({ where: { id } });
    await this.audit.record({
      actor,
      action: "LOGIN_LOCATION_UNTRUST",
      entity: "TrustedLoginLocation",
      entityId: id,
      before: removed,
      ...ctx,
    });
    return { removed: true };
  }

  // ---------------------------------------------------------------- consent

  /**
   * Precise browser GPS is only ever recorded with explicit consent, and the
   * user can withdraw it. Under the DPDP Act that consent has to be a positive
   * act and a revocable one — this is where that lives.
   */
  async getConsent(user: AuthenticatedUser) {
    const consent = await this.prisma.locationConsent.findUnique({ where: { userId: user.id } });
    return (
      consent ?? {
        userId: user.id,
        status: LocationConsentStatus.PENDING,
        latitude: null,
        longitude: null,
        capturedAt: null,
      }
    );
  }

  async setConsent(user: AuthenticatedUser, dto: ConsentDto, userAgent?: string) {
    const granted = dto.status === LocationConsentStatus.GRANTED;
    return this.prisma.locationConsent.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        userName: user.name,
        userRole: user.role,
        status: dto.status,
        respondedAt: new Date(),
        latitude: granted ? dto.latitude : null,
        longitude: granted ? dto.longitude : null,
        accuracyM: granted ? dto.accuracyM : null,
        capturedAt: granted && dto.latitude != null ? new Date() : null,
        userAgent,
      },
      update: {
        status: dto.status,
        respondedAt: new Date(),
        // Withdrawing consent erases the stored fix, it does not just stop new ones.
        latitude: granted ? (dto.latitude ?? undefined) : null,
        longitude: granted ? (dto.longitude ?? undefined) : null,
        accuracyM: granted ? (dto.accuracyM ?? undefined) : null,
        capturedAt: granted && dto.latitude != null ? new Date() : null,
        userAgent,
      },
    });
  }
}
