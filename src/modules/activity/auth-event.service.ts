import { Injectable, Logger } from "@nestjs/common";
import { AuthEventType, Prisma, UserRole } from "@prisma/client";
import type { Request } from "express";

import { PrismaService } from "@/prisma/prisma.service";
import {
  clientIp,
  haversineKm,
  impliedSpeedKmh,
  resolveGeo,
  type GeoInfo,
} from "@/common/utils/geo-ip.util";
import { parseDevice, type ClientHints, type DeviceInfo } from "@/common/utils/device.util";

export type AnomalySeverity = "low" | "medium" | "high";

export interface Anomaly {
  code: string;
  severity: AnomalySeverity;
  detail: string;
}

/** Above this implied speed, travel between two logins is not physically possible. */
const IMPOSSIBLE_TRAVEL_KMH = 900;

const SEVERITY_WEIGHT: Record<AnomalySeverity, number> = { low: 15, medium: 35, high: 60 };

export interface LoginContext {
  ip: string;
  geo: GeoInfo;
  device: DeviceInfo;
  userAgent?: string;
  clientTimezone?: string;
}

export interface RecordEventInput {
  eventType: AuthEventType;
  context: LoginContext;
  userId?: string | null;
  userName?: string | null;
  userRole?: UserRole | null;
  sessionId?: string | null;
  identifierTried?: string | null;
  failureReason?: string | null;
  gps?: { latitude?: number; longitude?: number; accuracyM?: number };
  anomalies?: Anomaly[];
  riskScore?: number;
}

/**
 * Login auditing and anomaly detection.
 *
 * Nothing here is allowed to throw into the authentication flow. Losing an
 * audit row is bad; refusing a legitimate attendant at the kerb because a
 * geolocation API was slow is worse. Every database touch is wrapped.
 */
@Injectable()
export class AuthEventService {
  private readonly logger = new Logger(AuthEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Builds the network and device context for a request. Never throws. */
  async buildContext(req: Request, hints?: ClientHints): Promise<LoginContext> {
    const ip = clientIp(req);
    const userAgent = req.header("user-agent") ?? undefined;
    let geo: GeoInfo = { source: "unknown" };
    try {
      geo = await resolveGeo(req, ip);
    } catch (error) {
      this.logger.warn(`Geo lookup failed for ${ip}: ${String(error)}`);
    }
    return {
      ip,
      geo,
      device: parseDevice(userAgent, hints),
      userAgent,
      clientTimezone: hints?.timezone,
    };
  }

  async record(input: RecordEventInput): Promise<void> {
    const { context: ctx } = input;
    try {
      await this.prisma.authEvent.create({
        data: {
          eventType: input.eventType,
          userId: input.userId ?? null,
          userName: input.userName ?? null,
          userRole: input.userRole ?? null,
          sessionId: input.sessionId ?? null,
          identifierTried: input.identifierTried ?? null,
          failureReason: input.failureReason ?? null,

          ipAddress: ctx.ip || null,
          city: ctx.geo.city,
          district: ctx.geo.district,
          region: ctx.geo.region,
          postal: ctx.geo.postal,
          country: ctx.geo.country,
          latitude: ctx.geo.latitude,
          longitude: ctx.geo.longitude,
          geoSource: ctx.geo.source,
          isp: ctx.geo.isp,
          asn: ctx.geo.asn,
          org: ctx.geo.org,
          isVpnOrProxy: ctx.geo.isVpnOrProxy,
          ipTimezone: ctx.geo.ipTimezone,

          userAgent: ctx.userAgent,
          browserName: ctx.device.browserName,
          osName: ctx.device.osName,
          deviceType: ctx.device.deviceType,
          deviceFingerprint: ctx.device.fingerprint,
          clientTimezone: ctx.clientTimezone,

          gpsLatitude: input.gps?.latitude,
          gpsLongitude: input.gps?.longitude,
          gpsAccuracyM: input.gps?.accuracyM,

          riskScore: input.riskScore,
          anomalies: input.anomalies?.length
            ? (input.anomalies as unknown as Prisma.InputJsonValue)
            : undefined,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to record ${input.eventType}`, String(error));
    }
  }

  /** Anchors concurrent-session detection. Best effort. */
  async openSession(args: {
    sessionId: string;
    userId: string;
    userName?: string;
    userRole?: UserRole;
    expiresAt: Date;
    context: LoginContext;
  }): Promise<void> {
    try {
      await this.prisma.loginSession.create({
        data: {
          sessionId: args.sessionId,
          userId: args.userId,
          userName: args.userName,
          userRole: args.userRole,
          expiresAt: args.expiresAt,
          ipAddress: args.context.ip || null,
          city: args.context.geo.city,
          district: args.context.geo.district,
          region: args.context.geo.region,
          country: args.context.geo.country,
          latitude: args.context.geo.latitude,
          longitude: args.context.geo.longitude,
          isp: args.context.geo.isp,
          asn: args.context.geo.asn,
          isVpnOrProxy: args.context.geo.isVpnOrProxy,
          deviceFingerprint: args.context.device.fingerprint,
          userAgent: args.context.userAgent,
        },
      });
    } catch (error) {
      this.logger.error("Failed to open login session", String(error));
    }
  }

  async closeSession(sessionId: string, reason: string): Promise<void> {
    if (!sessionId) return;
    await this.prisma.loginSession
      .updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      })
      .catch(() => undefined);
  }

  async closeAllForUser(userId: string, reason: string): Promise<number> {
    const { count } = await this.prisma.loginSession
      .updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      })
      .catch(() => ({ count: 0 }));
    return count;
  }

  /** Keeps the active-session list honest without a write on every request. */
  async touchSession(sessionId: string): Promise<void> {
    await this.prisma.loginSession
      .updateMany({ where: { sessionId, revokedAt: null }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------ trust

  /**
   * Is this (user, IP) pair on the approved allowlist? Approving a flagged
   * login adds its IP here so the same place never flags again.
   */
  async isTrusted(userId: string, ip?: string | null): Promise<boolean> {
    if (!ip) return false;
    try {
      const trusted = await this.prisma.trustedLoginLocation.findUnique({
        where: { userId_ipAddress: { userId, ipAddress: ip } },
        select: { id: true },
      });
      if (!trusted) return false;
      await this.prisma.trustedLoginLocation
        .update({ where: { id: trusted.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------- detection

  /**
   * Inspects recent history and live sessions for signals that suggest a shared
   * account or a compromised one.
   *
   * The attendant signals matter most here: a parking attendant account is
   * meant to be one person on one handset at one kerb. Two live sessions in
   * different cities is the shape account-sharing takes, and it is exactly what
   * lets collected cash go unrecorded.
   */
  async detectAnomalies(args: {
    userId: string;
    role: UserRole;
    context: LoginContext;
    now?: Date;
  }): Promise<{ anomalies: Anomaly[]; riskScore: number }> {
    const { userId, role, context } = args;
    const now = args.now ?? new Date();
    const { geo, device, ip, clientTimezone } = context;
    const anomalies: Anomaly[] = [];

    if (await this.isTrusted(userId, ip)) return { anomalies: [], riskScore: 0 };

    // 1. Concurrent live sessions from a different place or network.
    const live = await this.prisma.loginSession
      .findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { lastSeenAt: "desc" },
        take: 20,
      })
      .catch(() => []);

    for (const session of live) {
      const differentCity = geo.city && session.city && geo.city !== session.city;
      const differentAsn = geo.asn && session.asn && geo.asn !== session.asn;
      const apart = haversineKm(geo, session);
      if (differentCity || differentAsn || (apart != null && apart > 100)) {
        anomalies.push({
          code: "CONCURRENT_SESSION_DIFFERENT_LOCATION",
          severity: "high",
          detail: `Another live session from ${session.city ?? session.ipAddress ?? "an unknown place"}${
            session.asn ? ` (${session.asn})` : ""
          } while signing in from ${geo.city ?? "an unknown place"}${geo.asn ? ` (${geo.asn})` : ""}.`,
        });
        break;
      }
    }

    // 2. Impossible travel since the last successful login.
    const previous = await this.prisma.authEvent
      .findFirst({
        where: {
          userId,
          eventType: AuthEventType.LOGIN_SUCCESS,
          latitude: { not: null },
          longitude: { not: null },
        },
        orderBy: { createdAt: "desc" },
      })
      .catch(() => null);

    if (previous && geo.latitude != null && geo.longitude != null) {
      const distance = haversineKm(geo, previous);
      if (distance != null && distance > 50) {
        const elapsed = now.getTime() - previous.createdAt.getTime();
        const speed = impliedSpeedKmh(distance, elapsed);
        if (speed > IMPOSSIBLE_TRAVEL_KMH) {
          anomalies.push({
            code: "IMPOSSIBLE_TRAVEL",
            severity: "high",
            detail: `${Math.round(distance)} km from the previous sign-in ${Math.round(
              elapsed / 60000,
            )} minutes earlier — about ${Math.round(speed)} km/h.`,
          });
        }
      }
    }

    // 3. VPN, proxy or hosting network.
    if (geo.isVpnOrProxy) {
      anomalies.push({
        code: "VPN_OR_PROXY",
        severity: "medium",
        detail: `Signed in over a VPN, proxy or hosting network${geo.isp ? ` (${geo.isp})` : ""}.`,
      });
    }

    // 4. Browser timezone disagreeing with the IP's timezone.
    if (clientTimezone && geo.ipTimezone && clientTimezone !== geo.ipTimezone) {
      anomalies.push({
        code: "TIMEZONE_MISMATCH",
        severity: "medium",
        detail: `Device timezone ${clientTimezone} does not match the network's ${geo.ipTimezone}.`,
      });
    }

    // 5. A device this account has never used.
    const seenDevice = await this.prisma.authEvent
      .findFirst({
        where: {
          userId,
          deviceFingerprint: device.fingerprint,
          eventType: AuthEventType.LOGIN_SUCCESS,
        },
        select: { id: true },
      })
      .catch(() => null);

    if (!seenDevice) {
      anomalies.push({
        code: "NEW_DEVICE",
        // A field account moving handset is a much stronger signal than an
        // officer opening the portal on a new laptop.
        severity: role === UserRole.ATTENDANT || role === UserRole.VENDOR ? "medium" : "low",
        detail: `First sign-in from this device (${device.browserName ?? "unknown browser"} on ${
          device.osName ?? "unknown OS"
        }).`,
      });
    }

    // 6. A country this account has never signed in from.
    if (geo.country) {
      const seenCountry = await this.prisma.authEvent
        .findFirst({
          where: { userId, country: geo.country, eventType: AuthEventType.LOGIN_SUCCESS },
          select: { id: true },
        })
        .catch(() => null);
      if (!seenCountry) {
        anomalies.push({
          code: "NEW_COUNTRY",
          severity: "medium",
          detail: `First sign-in from ${geo.country}.`,
        });
      }
    }

    // 7. An established account appearing from a new city.
    if (geo.city) {
      const priorLogins = await this.prisma.authEvent
        .count({ where: { userId, eventType: AuthEventType.LOGIN_SUCCESS } })
        .catch(() => 0);
      if (priorLogins >= 3) {
        const seenCity = await this.prisma.authEvent
          .findFirst({
            where: { userId, city: geo.city, eventType: AuthEventType.LOGIN_SUCCESS },
            select: { id: true },
          })
          .catch(() => null);
        if (!seenCity) {
          anomalies.push({
            code: "UNUSUAL_LOCALITY",
            severity: "medium",
            detail: `Signed in from ${[geo.district, geo.city].filter(Boolean).join(", ")}, which this account does not normally use.`,
          });
        }
      }
    }

    // 8. Repeated failures against this account immediately before success.
    const recentFailures = await this.prisma.authEvent
      .count({
        where: {
          userId,
          eventType: AuthEventType.LOGIN_FAILED,
          createdAt: { gt: new Date(now.getTime() - 15 * 60_000) },
        },
      })
      .catch(() => 0);
    if (recentFailures >= 5) {
      anomalies.push({
        code: "SUCCESS_AFTER_REPEATED_FAILURES",
        severity: "high",
        detail: `${recentFailures} failed attempts on this account in the previous 15 minutes.`,
      });
    }

    const riskScore = Math.min(
      100,
      anomalies.reduce((sum, a) => sum + SEVERITY_WEIGHT[a.severity], 0),
    );

    return { anomalies, riskScore };
  }
}
