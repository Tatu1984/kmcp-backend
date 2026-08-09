import { Injectable, Logger } from "@nestjs/common";
import { SYSTEM_ROLES, type RoleCode } from "@/common/rbac/permissions";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { generateTotpSecret, totpKeyUri, verifyTotp } from "@/common/utils/totp.util";
import { AuthEventType, UserStatus } from "@prisma/client";
import type { Request } from "express";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { APP } from "@/config/app.constants";
import type { Env } from "@/config/env.config";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { TokenService, type TokenPair } from "./token.service";
import { AuthEventService, type LoginContext } from "@/modules/activity/auth-event.service";
import type {
  BindDeviceDto,
  ChangePasswordDto,
  LoginDto,
  OtpRequestDto,
  OtpVerifyDto,
  TwoFactorDto,
} from "./dto/auth.dto";

interface TwoFactorChallenge {
  userId: string;
  deviceFingerprint?: string;
  platform: string;
  expiresAt: string;
}

export interface LoginResult {
  status: "authenticated" | "two_factor_required";
  challengeId?: string;
  tokens?: TokenPair;
  user?: Omit<AuthenticatedUser, "sessionId" | "zoneIds" | "isZoneScoped">;
  /** What the anomaly engine made of this sign-in. */
  security?: { riskScore: number; anomalies: { code: string; severity: string; detail: string }[] };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly events: AuthEventService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ------------------------------------------------------------------ staff

  async login(dto: LoginDto, req: Request): Promise<LoginResult> {
    const ctx = await this.events.buildContext(req, { timezone: dto.timezone });
    const ip = ctx.ip;
    // Whichever identifier was supplied. The schema guarantees exactly one.
    const identifier = dto.email ? dto.email.toLowerCase() : (dto.phone as string);
    const user = await this.prisma.user.findFirst({
      where: {
        ...(dto.email ? { email: identifier } : { phone: identifier }),
        deletedAt: null,
      },
      include: { vendor: { select: { id: true } }, attendant: { select: { id: true } } },
    });

    // Always spend the cost of a hash so a missing account and a wrong password
    // take the same time — otherwise the response time enumerates our users.
    const hash = user?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";
    const passwordOk = await bcrypt.compare(dto.password, hash);

    if (!user || !user.passwordHash || !passwordOk) {
      await this.events.record({
        eventType: AuthEventType.LOGIN_FAILED,
        context: ctx,
        userId: user?.id ?? null,
        userName: user?.name ?? null,
        userRole: user?.role ?? null,
        identifierTried: identifier,
        failureReason: user ? "Wrong password" : "No such account",
      });
      throw new AppException("INVALID_CREDENTIALS");
    }

    if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.BLACKLISTED) {
      await this.events.record({
        eventType: AuthEventType.LOGIN_FAILED,
        context: ctx,
        userId: user.id,
        userName: user.name,
        userRole: user.role,
        identifierTried: identifier,
        failureReason: "Account suspended",
      });
      throw new AppException("ACCOUNT_SUSPENDED");
    }

    if (user.twoFactorEnabled && user.twoFactorSecret) {
      const challengeId = randomUUID();
      const challenge: TwoFactorChallenge = {
        userId: user.id,
        deviceFingerprint: dto.deviceFingerprint,
        platform: dto.platform,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
      await this.prisma.systemConfig.create({
        data: { key: `2fa:${challengeId}`, value: challenge as never },
      });
      return { status: "two_factor_required", challengeId };
    }

    return this.completeLogin(user.id, dto.deviceFingerprint, dto.platform, ctx, identifier);
  }

  async verifyTwoFactor(dto: TwoFactorDto, req: Request): Promise<LoginResult> {
    const ctx = await this.events.buildContext(req);
    const key = `2fa:${dto.challengeId}`;
    const row = await this.prisma.systemConfig.findUnique({ where: { key } });
    if (!row) throw new AppException("OTP_INVALID");

    const challenge = row.value as unknown as TwoFactorChallenge;
    if (new Date(challenge.expiresAt).getTime() < Date.now()) {
      await this.prisma.systemConfig.delete({ where: { key } }).catch(() => undefined);
      throw new AppException("OTP_INVALID");
    }

    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user?.twoFactorSecret) throw new AppException("OTP_INVALID");

    const valid = verifyTotp(dto.code, user.twoFactorSecret);
    if (!valid) {
      await this.events.record({
        eventType: AuthEventType.LOGIN_FAILED,
        context: ctx,
        userId: user.id,
        userName: user.name,
        userRole: user.role,
        identifierTried: user.email ?? user.id,
        failureReason: "Wrong or expired authenticator code",
      });
      throw new AppException("OTP_INVALID");
    }

    await this.prisma.systemConfig.delete({ where: { key } }).catch(() => undefined);
    return this.completeLogin(
      user.id,
      challenge.deviceFingerprint,
      challenge.platform,
      ctx,
      user.email ?? user.id,
    );
  }

  private async completeLogin(
    userId: string,
    deviceFingerprint: string | undefined,
    platform: string,
    ctx: LoginContext,
    identifier: string,
  ): Promise<LoginResult> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { vendor: { select: { id: true } }, attendant: { select: { id: true, vendorId: true } } },
    });

    if (deviceFingerprint) {
      await this.upsertDevice(user.id, { fingerprint: deviceFingerprint, platform: platform as never });
    }

    // Score the sign-in before issuing tokens, so the event carries the verdict.
    const { anomalies, riskScore } = await this.events.detectAnomalies({
      userId: user.id,
      role: user.role,
      context: ctx,
    });

    const tokens = await this.tokens.issue(user, deviceFingerprint);
    const sessionId = this.tokens.sessionIdOf(tokens.accessToken);

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    await this.events.openSession({
      sessionId,
      userId: user.id,
      userName: user.name,
      userRole: user.role,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      context: ctx,
    });

    await this.events.record({
      eventType: AuthEventType.LOGIN_SUCCESS,
      context: ctx,
      userId: user.id,
      userName: user.name,
      userRole: user.role,
      sessionId,
      identifierTried: identifier,
      anomalies,
      riskScore,
    });

    return {
      status: "authenticated",
      tokens,
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        phone: user.phone,
        vendorId: user.vendor?.id ?? user.attendant?.vendorId ?? null,
        attendantId: user.attendant?.id ?? null,
      },
      security: {
        riskScore,
        anomalies,
      },
    };
  }

  // ---------------------------------------------------------------- citizen

  async requestOtp(dto: OtpRequestDto): Promise<{ sent: true; expiresInSeconds: number; devCode?: string }> {
    const ttl = this.config.get("OTP_TTL_SECONDS", { infer: true });
    const code = String(Math.floor(100000 + Math.random() * 900000));

    await this.prisma.otpRequest.create({
      data: {
        phone: dto.phone,
        codeHash: createHash("sha256").update(code).digest("hex"),
        expiresAt: new Date(Date.now() + ttl * 1000),
      },
    });

    // TODO: dispatch through MSG91 once the DLT template is approved.
    const isProduction = this.config.get("NODE_ENV", { infer: true }) === "production";
    if (!isProduction) this.logger.debug(`OTP for ${dto.phone}: ${code}`);

    return { sent: true, expiresInSeconds: ttl, ...(isProduction ? {} : { devCode: code }) };
  }

  async verifyOtp(dto: OtpVerifyDto, req: Request): Promise<LoginResult> {
    const ctx = await this.events.buildContext(req);
    const maxAttempts = this.config.get("OTP_MAX_ATTEMPTS", { infer: true });

    const request = await this.prisma.otpRequest.findFirst({
      where: { phone: dto.phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!request) throw new AppException("OTP_INVALID");

    if (request.attempts >= maxAttempts) {
      throw new AppException("RATE_LIMITED", undefined, "Too many attempts. Request a new code.");
    }

    const supplied = createHash("sha256").update(dto.code).digest("hex");
    const matches =
      supplied.length === request.codeHash.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(request.codeHash));

    if (!matches) {
      await this.prisma.otpRequest.update({
        where: { id: request.id },
        data: { attempts: { increment: 1 } },
      });
      await this.events.record({
        eventType: AuthEventType.LOGIN_FAILED,
        context: ctx,
        identifierTried: dto.phone,
        failureReason: "Wrong OTP",
      });
      throw new AppException("OTP_INVALID");
    }

    await this.prisma.otpRequest.update({
      where: { id: request.id },
      data: { consumedAt: new Date() },
    });

    // First verified OTP for a number creates the citizen account.
    const user = await this.prisma.user.upsert({
      where: { phone: dto.phone },
      create: {
        phone: dto.phone,
        name: dto.name?.trim() || "Citizen",
        role: SYSTEM_ROLES.CITIZEN,
        status: UserStatus.ACTIVE,
      },
      update: { lastLoginAt: new Date() },
    });

    if (user.status === UserStatus.BLACKLISTED) throw new AppException("ACCOUNT_SUSPENDED");

    if (dto.deviceFingerprint) {
      await this.upsertDevice(user.id, {
        fingerprint: dto.deviceFingerprint,
        platform: dto.platform,
        pushToken: dto.pushToken,
      });
    }

    const tokens = await this.tokens.issue(user, dto.deviceFingerprint);
    const sessionId = this.tokens.sessionIdOf(tokens.accessToken);

    await this.events.openSession({
      sessionId,
      userId: user.id,
      userName: user.name,
      userRole: user.role,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      context: ctx,
    });
    await this.events.record({
      eventType: AuthEventType.LOGIN_SUCCESS,
      context: ctx,
      userId: user.id,
      userName: user.name,
      userRole: user.role,
      sessionId,
      identifierTried: dto.phone,
    });

    return {
      status: "authenticated",
      tokens,
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        phone: user.phone,
        vendorId: null,
        attendantId: null,
      },
    };
  }

  // ----------------------------------------------------------------- tokens

  refresh(refreshToken: string): Promise<TokenPair> {
    return this.tokens.rotate(refreshToken);
  }

  async logout(refreshToken: string): Promise<{ revoked: true }> {
    const sessionId = await this.tokens.revoke(refreshToken);
    if (sessionId) await this.events.closeSession(sessionId, "Signed out");
    return { revoked: true };
  }

  async logoutEverywhere(userId: string): Promise<{ revokedSessions: number }> {
    const revokedSessions = await this.tokens.revokeAllForUser(userId);
    await this.events.closeAllForUser(userId, "Signed out of every device");
    return { revokedSessions };
  }

  // --------------------------------------------------------------- profile

  async me(user: AuthenticatedUser) {
    const record = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        twoFactorEnabled: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    return { ...record, zoneIds: user.zoneIds, vendorId: user.vendorId, attendantId: user.attendantId };
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<{ changed: true }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash) throw new AppException("INVALID_CREDENTIALS");

    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) throw new AppException("INVALID_CREDENTIALS", [
      { field: "currentPassword", issue: "does not match" },
    ]);

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) },
    });

    // A password change should not leave old sessions alive elsewhere.
    await this.tokens.revokeAllForUser(userId);
    return { changed: true };
  }

  // ------------------------------------------------------------------- 2FA

  async setupTwoFactor(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const secret = generateTotpSecret();

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret, twoFactorEnabled: false },
    });

    return {
      secret,
      otpauthUrl: totpKeyUri(user.email ?? user.name, `${APP.name} Parking`, secret),
    };
  }

  async confirmTwoFactor(userId: string, code: string): Promise<{ enabled: true }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorSecret) throw new AppException("OTP_INVALID");

    if (!verifyTotp(code, user.twoFactorSecret)) {
      throw new AppException("OTP_INVALID");
    }

    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
    return { enabled: true };
  }

  async disableTwoFactor(targetUserId: string): Promise<{ disabled: true }> {
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });
    return { disabled: true };
  }

  // --------------------------------------------------------------- devices

  async upsertDevice(userId: string, dto: BindDeviceDto) {
    return this.prisma.device.upsert({
      where: { userId_fingerprint: { userId, fingerprint: dto.fingerprint } },
      create: {
        userId,
        fingerprint: dto.fingerprint,
        platform: dto.platform,
        appVersion: dto.appVersion,
        pushToken: dto.pushToken,
        lastSeenAt: new Date(),
        isActive: true,
      },
      update: {
        platform: dto.platform,
        appVersion: dto.appVersion ?? undefined,
        pushToken: dto.pushToken ?? undefined,
        lastSeenAt: new Date(),
        isActive: true,
      },
      select: {
        id: true,
        fingerprint: true,
        platform: true,
        appVersion: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  listDevices(userId: string) {
    return this.prisma.device.findMany({
      where: { userId },
      orderBy: { lastSeenAt: "desc" },
      select: {
        id: true,
        platform: true,
        fingerprint: true,
        appVersion: true,
        isActive: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });
  }

  async unbindDevice(userId: string, deviceId: string): Promise<{ unbound: true }> {
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, userId } });
    if (!device) throw AppException.notFound("device");

    await this.prisma.device.update({
      where: { id: deviceId },
      data: { isActive: false, pushToken: null },
    });
    return { unbound: true };
  }
}
