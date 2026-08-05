import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { UserStatus } from "@prisma/client";
import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "../errors/app.exception";
import {
  IS_PUBLIC_KEY,
  SKIP_DEVICE_BINDING_KEY,
  type AuthenticatedUser,
} from "../decorators/auth.decorators";
import { HEADERS } from "@/config/app.constants";
import type { Env } from "@/config/env.config";

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  role: string;
  did?: string;
}

/**
 * Verifies the bearer token, loads the principal with its zone scope, and
 * enforces device binding for field accounts.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = this.extractToken(request);
    if (!token) throw new AppException("UNAUTHENTICATED");

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.get("JWT_ACCESS_SECRET", { infer: true }),
      });
    } catch {
      throw new AppException("UNAUTHENTICATED");
    }

    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, deletedAt: null },
      include: {
        vendor: { select: { id: true, status: true, zones: { select: { zoneId: true, endedAt: true } } } },
        attendant: { select: { id: true, vendorId: true, defaultZoneId: true, isActive: true } },
      },
    });

    if (!user) throw new AppException("UNAUTHENTICATED");
    if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.BLACKLISTED) {
      throw new AppException("ACCOUNT_SUSPENDED");
    }

    const deviceId = request.header(HEADERS.deviceId) ?? undefined;
    const skipBinding = this.reflector.getAllAndOverride<boolean>(SKIP_DEVICE_BINDING_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Field accounts are bound to one handset — that is what stops an attendant
    // login being shared around a depot.
    if (!skipBinding && user.attendant) {
      if (!deviceId) throw new AppException("DEVICE_NOT_BOUND");
      const bound = await this.prisma.device.findFirst({
        where: { userId: user.id, fingerprint: deviceId, isActive: true },
        select: { id: true },
      });
      if (!bound) throw new AppException("DEVICE_NOT_BOUND");
    }

    request.user = {
      id: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      phone: user.phone,
      vendorId: user.vendor?.id ?? user.attendant?.vendorId ?? null,
      attendantId: user.attendant?.id ?? null,
      zoneIds: await this.resolveZoneScope(user.id, user.vendor, user.attendant),
      deviceId,
      sessionId: claims.sid,
    };

    return true;
  }

  private async resolveZoneScope(
    userId: string,
    vendor: { zones: { zoneId: string; endedAt: Date | null }[] } | null,
    attendant: { vendorId: string; defaultZoneId: string | null } | null,
  ): Promise<string[]> {
    if (vendor) return vendor.zones.filter((z) => !z.endedAt).map((z) => z.zoneId);

    if (attendant) {
      const assignments = await this.prisma.vendorZone.findMany({
        where: { vendorId: attendant.vendorId, endedAt: null },
        select: { zoneId: true },
      });
      return assignments.map((a) => a.zoneId);
    }

    // Zone officers carry an explicit list in system config; everyone else is
    // unrestricted and gets an empty array.
    const scope = await this.prisma.systemConfig.findUnique({
      where: { key: `zoneScope:${userId}` },
    });
    return Array.isArray(scope?.value) ? (scope.value as string[]) : [];
  }

  private extractToken(request: Request): string | undefined {
    const header = request.header("authorization");
    if (!header?.startsWith("Bearer ")) return undefined;
    return header.slice(7).trim() || undefined;
  }
}
