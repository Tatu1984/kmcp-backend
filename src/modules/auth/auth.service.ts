import { Injectable, Logger } from "@nestjs/common";
import { PERMISSIONS, SYSTEM_ROLES, type RoleCode } from "@/common/rbac/permissions";
import { RolesService } from "@/common/rbac/roles.service";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { generateTotpSecret, totpKeyUri, verifyTotp } from "@/common/utils/totp.util";
import { AuthEventType, OtpPurpose, UserStatus } from "@prisma/client";
import type { Request } from "express";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { APP } from "@/config/app.constants";
import type { Env } from "@/config/env.config";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { TokenService, type TokenPair } from "./token.service";
import { OtpService, maskEmail } from "./otp.service";
import { AuthEventService, type LoginContext } from "@/modules/activity/auth-event.service";
import type {
  BindDeviceDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  OtpRequestDto,
  OtpVerifyDto,
  ResetPasswordDto,
  TwoFactorDto,
} from "./dto/auth.dto";

interface TwoFactorChallenge {
  userId: string;
  deviceFingerprint?: string;
  platform: string;
  expiresAt: string;
  /**
   * How the second factor is proved. Absent on challenges written before
   * emailed codes existed, which were all authenticator challenges.
   */
  method?: "totp" | "email";
  /** For an emailed code, the `OtpRequest` row it was sent as. */
  otpRequestId?: string;
}

/** How long a sign-in may sit between the password and the second factor. */
const CHALLENGE_TTL_MS = 10 * 60_000;

/** What an attendant sees when a second handset tries to sign in. */
const BOUND_ELSEWHERE_MESSAGE =
  "Your account is bound to another device. Ask your supervisor to release it before signing in here.";

export interface LoginResult {
  status: "authenticated" | "two_factor_required";
  challengeId?: string;
  /** With `two_factor_required`: an authenticator code, or one we emailed. */
  method?: "totp" | "email";
  /** With an emailed code: the address it went to, masked. */
  sentTo?: string;
  /** With an emailed code, and only under AUTH_DEV_BYPASS. */
  devCode?: string;
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
    private readonly roles: RolesService,
    private readonly otp: OtpService,
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

    // A fixed override password for every staff account, for a developer
    // testing against a seeded database who does not know any particular
    // attendant's real password. Only under AUTH_DEV_BYPASS, which the
    // environment check refuses in production. It skips the password, not the
    // second factor: an attendant still needs the emailed code.
    const devOverride = this.otp.devBypass && dto.password === "000000";

    // Always spend the cost of a hash so a missing account and a wrong password
    // take the same time — otherwise the response time enumerates our users.
    const hash = user?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";
    const passwordOk = devOverride ? Boolean(user?.passwordHash) : await bcrypt.compare(dto.password, hash);

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
      const challengeId = await this.openChallenge({
        userId: user.id,
        deviceFingerprint: dto.deviceFingerprint,
        platform: dto.platform,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        method: "totp",
      });
      return { status: "two_factor_required", challengeId, method: "totp" };
    }

    /**
     * An attendant proves the password and then a code emailed to them.
     *
     * A password alone is the weakest thing guarding the one account that
     * starts sessions and takes cash, and it is the one most likely to be
     * shared across a depot. Without an email on file there is nowhere to send
     * the code, so the sign-in is refused with that reason rather than let
     * through on the password.
     */
    if (user.attendant) {
      if (!user.email) {
        await this.events.record({
          eventType: AuthEventType.LOGIN_FAILED,
          context: ctx,
          userId: user.id,
          userName: user.name,
          userRole: user.role,
          identifierTried: identifier,
          failureReason: "No email on file for the second step",
        });
        throw new AppException("EMAIL_NOT_ON_FILE");
      }

      // Refuse a second handset before mailing anything, so the attendant
      // does not wait for a code only to be turned away after typing it.
      if (dto.deviceFingerprint && (await this.otherActiveDevice(user.id, dto.deviceFingerprint))) {
        await this.events.record({
          eventType: AuthEventType.LOGIN_FAILED,
          context: ctx,
          userId: user.id,
          userName: user.name,
          userRole: user.role,
          identifierTried: identifier,
          failureReason: "Bound to another device",
        });
        throw new AppException("DEVICE_NOT_BOUND", undefined, BOUND_ELSEWHERE_MESSAGE);
      }

      const issued = await this.otp.issue({
        purpose: OtpPurpose.STAFF_SIGN_IN,
        email: user.email,
        userId: user.id,
      });
      const challengeId = await this.openChallenge({
        userId: user.id,
        deviceFingerprint: dto.deviceFingerprint,
        platform: dto.platform,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
        method: "email",
        otpRequestId: issued.otpRequestId,
      });
      return {
        status: "two_factor_required",
        challengeId,
        method: "email",
        sentTo: maskEmail(user.email),
        ...(issued.devCode ? { devCode: issued.devCode } : {}),
      };
    }

    return this.completeLogin(user.id, dto.deviceFingerprint, dto.platform, ctx, identifier);
  }

  private async openChallenge(challenge: TwoFactorChallenge): Promise<string> {
    const challengeId = randomUUID();
    await this.prisma.systemConfig.create({
      data: { key: `2fa:${challengeId}`, value: challenge as never },
    });
    return challengeId;
  }

  /** A live challenge, or OTP_INVALID. An expired one is removed on the way. */
  private async readChallenge(challengeId: string): Promise<TwoFactorChallenge> {
    const key = `2fa:${challengeId}`;
    const row = await this.prisma.systemConfig.findUnique({ where: { key } });
    if (!row) throw new AppException("OTP_INVALID");

    const challenge = row.value as unknown as TwoFactorChallenge;
    if (new Date(challenge.expiresAt).getTime() < Date.now()) {
      await this.prisma.systemConfig.delete({ where: { key } }).catch(() => undefined);
      throw new AppException("OTP_INVALID");
    }
    return challenge;
  }

  /**
   * Emails a fresh code for a sign-in that is waiting on one.
   *
   * The challenge is kept — the password was right and stays right — and is
   * pointed at the new code, which supersedes the old one.
   */
  async resendChallenge(challengeId: string): Promise<{ sentTo: string; expiresInSeconds: number; devCode?: string }> {
    const challenge = await this.readChallenge(challengeId);
    if (challenge.method !== "email") throw new AppException("OTP_INVALID");

    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user?.email) throw new AppException("OTP_INVALID");

    const issued = await this.otp.issue({
      purpose: OtpPurpose.STAFF_SIGN_IN,
      email: user.email,
      userId: user.id,
    });
    await this.prisma.systemConfig.update({
      where: { key: `2fa:${challengeId}` },
      data: { value: { ...challenge, otpRequestId: issued.otpRequestId } as never },
    });
    return {
      sentTo: maskEmail(user.email),
      expiresInSeconds: issued.expiresInSeconds,
      ...(issued.devCode ? { devCode: issued.devCode } : {}),
    };
  }

  async verifyTwoFactor(dto: TwoFactorDto, req: Request): Promise<LoginResult> {
    const ctx = await this.events.buildContext(req);
    const key = `2fa:${dto.challengeId}`;
    const challenge = await this.readChallenge(dto.challengeId);

    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user) throw new AppException("OTP_INVALID");

    let valid: boolean;
    if (challenge.method === "email") {
      if (!challenge.otpRequestId) throw new AppException("OTP_INVALID");
      const sent = await this.prisma.otpRequest.findUnique({ where: { id: challenge.otpRequestId } });
      // The row must be the staff code for this very account; the challenge
      // is server-written, but nothing is lost by checking what it points at.
      if (sent?.purpose !== OtpPurpose.STAFF_SIGN_IN || sent.userId !== user.id) {
        throw new AppException("OTP_INVALID");
      }
      valid = (await this.otp.consume(sent, dto.code)) === "ok";
    } else {
      if (!user.twoFactorSecret) throw new AppException("OTP_INVALID");
      valid = verifyTotp(dto.code, user.twoFactorSecret);
    }

    if (!valid) {
      await this.events.record({
        eventType: AuthEventType.LOGIN_FAILED,
        context: ctx,
        userId: user.id,
        userName: user.name,
        userRole: user.role,
        identifierTried: user.email ?? user.id,
        failureReason:
          challenge.method === "email" ? "Wrong emailed code" : "Wrong or expired authenticator code",
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
      // One handset per attendant, enforced here so a refused sign-in issues
      // nothing. The guard already refuses every later request from an
      // unbound handset; without this the login itself was the gap — a second
      // phone bound on sign-in and the first kept working. Release goes through
      // a supervisor (`POST /attendants/:id/unbind-device`), which flips the
      // old row to `isActive: false`; that is exactly the row this looks for.
      if (user.attendant && (await this.otherActiveDevice(user.id, deviceFingerprint))) {
        await this.events.record({
          eventType: AuthEventType.LOGIN_FAILED,
          context: ctx,
          userId: user.id,
          userName: user.name,
          userRole: user.role,
          identifierTried: identifier,
          failureReason: "Bound to another device",
        });
        throw new AppException("DEVICE_NOT_BOUND", undefined, BOUND_ELSEWHERE_MESSAGE);
      }
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
    const issued = await this.otp.issue({ purpose: OtpPurpose.CITIZEN_SIGN_IN, email: dto.email });
    return {
      sent: true,
      expiresInSeconds: issued.expiresInSeconds,
      ...(issued.devCode ? { devCode: issued.devCode } : {}),
    };
  }

  async verifyOtp(dto: OtpVerifyDto, req: Request): Promise<LoginResult> {
    const ctx = await this.events.buildContext(req);

    const sent = await this.otp.latestFor({ email: dto.email, purpose: OtpPurpose.CITIZEN_SIGN_IN });
    if ((await this.otp.consume(sent, dto.code)) === "wrong") {
      await this.events.record({
        eventType: AuthEventType.LOGIN_FAILED,
        context: ctx,
        identifierTried: dto.email,
        failureReason: "Wrong OTP",
      });
      throw new AppException("OTP_INVALID");
    }

    /**
     * An address that already belongs to staff does not become a citizen
     * sign-in. Upserting by email would otherwise hand an attendant's or an
     * officer's own tokens to anyone who can read their inbox, past their
     * password and their device binding.
     */
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing && existing.role !== SYSTEM_ROLES.CITIZEN) {
      await this.events.record({
        eventType: AuthEventType.LOGIN_FAILED,
        context: ctx,
        userId: existing.id,
        userName: existing.name,
        userRole: existing.role,
        identifierTried: dto.email,
        failureReason: "Staff email used on the citizen sign-in",
      });
      throw new AppException("STAFF_ACCOUNT");
    }

    // First verified code for an address creates the citizen account.
    const user = await this.prisma.user.upsert({
      where: { email: dto.email },
      create: {
        email: dto.email,
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
      identifierTried: dto.email,
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
    /**
     * The caller's effective permissions travel with the principal.
     *
     * Without this the portal cannot tell an Auditor that settlement approval
     * is not theirs — it would render the button, the API would refuse it, and
     * the user would learn their own access level from a red toast. The only
     * other source is `/rbac/matrix`, which is itself behind `user.manage`, so
     * precisely the roles that need this most cannot read it.
     *
     * A superuser is unrestricted by definition, so it receives the whole
     * catalogue rather than an empty set — the same answer `RolesService.can`
     * gives, expressed as a list.
     */
    const role = await this.roles.get(record.role);
    const permissions = role?.isSuperuser
      ? [...PERMISSIONS]
      : [...(role?.permissions ?? [])].sort();

    return {
      ...record,
      permissions,
      isZoneScoped: role?.isZoneScoped ?? false,
      isSuperuser: role?.isSuperuser ?? false,
      zoneIds: user.zoneIds,
      vendorId: user.vendorId,
      attendantId: user.attendantId,
    };
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

  /**
   * Emails a reset code to the address on a staff account.
   *
   * Answers the same whether or not an account matched, so this cannot be
   * used to find out who works here. A citizen has no password to reset, and
   * an account with no email has nowhere to send a code; both get the same
   * answer, and the app says what to do if nothing arrives.
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<{ sent: true; expiresInSeconds: number; devCode?: string }> {
    const ttl = this.config.get("OTP_TTL_SECONDS", { infer: true });
    const user = await this.findStaffAccount(dto);
    if (!user?.email || user.status !== UserStatus.ACTIVE) return { sent: true, expiresInSeconds: ttl };

    const issued = await this.otp.issue({
      purpose: OtpPurpose.PASSWORD_RESET,
      email: user.email,
      userId: user.id,
    });
    return {
      sent: true,
      expiresInSeconds: issued.expiresInSeconds,
      ...(issued.devCode ? { devCode: issued.devCode } : {}),
    };
  }

  /** Sets a new password with an emailed code, and signs out every session. */
  async resetPassword(dto: ResetPasswordDto): Promise<{ reset: true }> {
    const user = await this.findStaffAccount(dto);
    if (!user || user.status !== UserStatus.ACTIVE) throw new AppException("OTP_INVALID");

    const sent = await this.otp.latestFor({ userId: user.id, purpose: OtpPurpose.PASSWORD_RESET });
    if ((await this.otp.consume(sent, dto.code)) === "wrong") throw new AppException("OTP_INVALID");

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 12) },
    });
    // Whoever had the old password should not keep a session it opened.
    await this.tokens.revokeAllForUser(user.id);
    await this.events.closeAllForUser(user.id, "Password reset");
    return { reset: true };
  }

  private findStaffAccount(dto: { email?: string; phone?: string }) {
    return this.prisma.user.findFirst({
      where: {
        ...(dto.email ? { email: dto.email } : { phone: dto.phone }),
        role: { not: SYSTEM_ROLES.CITIZEN },
        passwordHash: { not: null },
        deletedAt: null,
      },
    });
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

  /**
   * The self-service bind route, which the guard lets an attendant reach from
   * an unregistered handset. It has to apply the same one-handset rule as
   * sign-in, or the rule is one extra request away from meaningless: sign in
   * without a fingerprint, then bind the second phone here.
   */
  async bindDevice(user: Pick<AuthenticatedUser, "id" | "attendantId">, dto: BindDeviceDto) {
    if (user.attendantId && (await this.otherActiveDevice(user.id, dto.fingerprint))) {
      throw new AppException("DEVICE_NOT_BOUND", undefined, BOUND_ELSEWHERE_MESSAGE);
    }
    return this.upsertDevice(user.id, dto);
  }

  /**
   * Is some *other* handset still bound to this account? "Bound" means a
   * `Device` row with `isActive: true` — the same test the guard applies on
   * every request, and the flag the supervisor's unbind route clears.
   */
  private async otherActiveDevice(userId: string, fingerprint: string): Promise<boolean> {
    const other = await this.prisma.device.findFirst({
      where: { userId, isActive: true, fingerprint: { not: fingerprint } },
      select: { id: true },
    });
    return other !== null;
  }

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
