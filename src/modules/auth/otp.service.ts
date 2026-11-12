import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationChannel, OtpPurpose, type OtpRequest } from "@prisma/client";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import type { Env } from "@/config/env.config";
import { ProviderRegistry } from "@/modules/messaging/providers/provider.registry";

/** A second request for the same address and purpose inside this is refused. */
const RESEND_COOLDOWN_MS = 30_000;
/** And no more than this many codes to one address and purpose in an hour. */
const HOURLY_LIMIT = 10;

export interface IssuedCode {
  otpRequestId: string;
  expiresInSeconds: number;
  /** Only with AUTH_DEV_BYPASS, which cannot be set in production. */
  devCode?: string;
}

/**
 * One-time codes, by email.
 *
 * Every code on the platform comes from here: a citizen signing in, an
 * attendant's second step after the password, a password reset. Generation,
 * storage, delivery and checking live together so the three flows cannot drift
 * into three different ideas of what a code is.
 *
 * A code is six digits from a CSPRNG, stored only as a hash, valid for
 * OTP_TTL_SECONDS, good for one use and OTP_MAX_ATTEMPTS guesses, and only
 * for the purpose it was issued for. Delivery goes through the messaging
 * registry, which is where retries live; a send that fails after its retries
 * fails the request, because a code nobody received is worse than an error.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: ProviderRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get devBypass(): boolean {
    return this.config.get("AUTH_DEV_BYPASS", { infer: true });
  }

  async issue(input: { purpose: OtpPurpose; email: string; userId?: string }): Promise<IssuedCode> {
    const email = input.email.trim().toLowerCase();
    const ttl = this.config.get("OTP_TTL_SECONDS", { infer: true });
    const now = Date.now();

    const recent = await this.prisma.otpRequest.findMany({
      where: { email, purpose: input.purpose, createdAt: { gt: new Date(now - 60 * 60_000) } },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
      take: HOURLY_LIMIT,
    });
    if (recent[0] && now - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new AppException("RATE_LIMITED", undefined, "Wait half a minute before asking for another code.");
    }
    if (recent.length >= HOURLY_LIMIT) {
      throw new AppException("RATE_LIMITED", undefined, "Too many codes asked for. Try again in an hour.");
    }

    const review = this.isReviewAccount(email);
    const code = review
      ? (this.config.get("REVIEW_ACCOUNT_CODE", { infer: true }) as string)
      : String(randomInt(0, 1_000_000)).padStart(6, "0");

    const row = await this.prisma.otpRequest.create({
      data: {
        purpose: input.purpose,
        email,
        userId: input.userId,
        codeHash: hash(code),
        expiresAt: new Date(now + ttl * 1000),
      },
    });

    // The reviewer's address is not a real inbox; mailing it would only bounce.
    if (!review) {
      const outcome = await this.messaging.send(NotificationChannel.EMAIL, {
        to: email,
        ...render(input.purpose, code, Math.round(ttl / 60)),
        template: `otp.${input.purpose.toLowerCase()}`,
      });
      if (!outcome.ok) {
        // DPDP: the purpose and the reason, never the address or the code.
        this.logger.warn(`Could not email a ${input.purpose} code: ${outcome.reason}`);
        if (!this.devBypass) {
          await this.prisma.otpRequest.delete({ where: { id: row.id } }).catch(() => undefined);
          throw new AppException(
            "SERVICE_UNAVAILABLE",
            undefined,
            "We could not send the email just now. Try again in a minute.",
          );
        }
      }
    }

    return { otpRequestId: row.id, expiresInSeconds: ttl, ...(this.devBypass ? { devCode: code } : {}) };
  }

  /**
   * Checks a code against the row it was issued as, and uses it up if right.
   *
   * Throws for a code that can no longer be right — missing, spent, expired,
   * or out of guesses. Returns "wrong" for a wrong guess, which has already
   * been counted, so the caller can record the failed sign-in in its own terms
   * before refusing it.
   */
  async consume(row: OtpRequest | null, code: string): Promise<"ok" | "wrong"> {
    if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
      throw new AppException("OTP_INVALID");
    }
    if (row.attempts >= this.config.get("OTP_MAX_ATTEMPTS", { infer: true })) {
      throw new AppException("RATE_LIMITED", undefined, "Too many attempts. Ask for a new code.");
    }

    const supplied = Buffer.from(hash(code));
    const stored = Buffer.from(row.codeHash);
    if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) {
      await this.prisma.otpRequest.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      return "wrong";
    }

    // Conditional on still being unspent, so two concurrent submissions of
    // the same right code cannot both sign in.
    const spent = await this.prisma.otpRequest.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (spent.count === 0) throw new AppException("OTP_INVALID");
    return "ok";
  }

  /** The newest code for an address and purpose that could still be used. */
  latestFor(where: { email?: string; userId?: string; purpose: OtpPurpose }) {
    return this.prisma.otpRequest.findFirst({
      where: { ...where, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
  }

  isReviewAccount(email: string | null | undefined): boolean {
    const review = this.config.get("REVIEW_ACCOUNT_EMAIL", { infer: true });
    return Boolean(review && email && email.trim().toLowerCase() === review);
  }
}

/** "ravi.kumar@gmail.com" → "r•••••••••@gmail.com", for "we sent it to …". */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  return `${local[0]}${"•".repeat(Math.max(local.length - 1, 2))}@${domain}`;
}

function hash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * The words of each email.
 *
 * The code goes in the subject too, so it can be read off a lock-screen
 * notification without opening the mail. Each body says what to do if the
 * reader did not ask for it, because for these three that is the question.
 */
function render(purpose: OtpPurpose, code: string, minutes: number): { subject: string; body: string } {
  const expiry = `It expires in ${minutes} minutes and works once.`;
  switch (purpose) {
    case OtpPurpose.CITIZEN_SIGN_IN:
      return {
        subject: `${code} is your Smart Parking sign-in code`,
        body: [
          "Your Smart Parking sign-in code is:",
          "",
          code,
          "",
          expiry,
          "",
          "If you did not try to sign in, ignore this email. Nobody can sign in without the code.",
        ].join("\n"),
      };
    case OtpPurpose.STAFF_SIGN_IN:
      return {
        subject: `${code} is your SP Vendor sign-in code`,
        body: [
          "Your password was accepted. Enter this code in SP Vendor to finish signing in:",
          "",
          code,
          "",
          expiry,
          "",
          "If this was not you, someone knows your password. Tell your supervisor and change it.",
        ].join("\n"),
      };
    case OtpPurpose.PASSWORD_RESET:
      return {
        subject: `${code} is your password reset code`,
        body: [
          "Use this code to choose a new password:",
          "",
          code,
          "",
          expiry,
          "",
          "If you did not ask to reset your password, ignore this email. Your password has not changed.",
        ].join("\n"),
      };
  }
}
