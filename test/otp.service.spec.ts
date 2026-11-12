import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { OtpService, maskEmail } from "../src/modules/auth/otp.service";
import { AppException } from "../src/common/errors/app.exception";

/**
 * Emailed one-time codes: issued, delivered, and checked.
 *
 * The cases that matter are the ones where the obvious implementation is
 * wrong — a send that fails still "succeeding", a code that works twice, a
 * reviewer account that mails a real inbox — so those are the ones pinned.
 */

const ENV: Record<string, unknown> = {
  OTP_TTL_SECONDS: 300,
  OTP_MAX_ATTEMPTS: 5,
  AUTH_DEV_BYPASS: false,
  REVIEW_ACCOUNT_EMAIL: undefined,
  REVIEW_ACCOUNT_CODE: undefined,
};

const sha = (code: string) => createHash("sha256").update(code).digest("hex");

function makeService(opts: { env?: Record<string, unknown>; recent?: Date[]; sendOk?: boolean } = {}) {
  const env = { ...ENV, ...opts.env };
  const prisma: any = {
    otpRequest: {
      findMany: vi.fn().mockResolvedValue((opts.recent ?? []).map((createdAt) => ({ createdAt }))),
      create: vi.fn(async ({ data }: any) => ({ id: "otp_1", ...data })),
      delete: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const messaging = {
    send: vi.fn().mockResolvedValue(
      opts.sendOk === false
        ? { ok: false, retryable: false, reason: "Email is not configured" }
        : { ok: true, providerRef: "re_1" },
    ),
  };
  const config = { get: vi.fn((key: string) => env[key]) };
  const service = new OtpService(prisma, messaging as any, config as any);
  return { service, prisma, messaging };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "otp_1",
    purpose: "CITIZEN_SIGN_IN",
    phone: null,
    email: "a@b.in",
    userId: null,
    codeHash: sha("123456"),
    attempts: 0,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as any;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe(code));
}

describe("issuing a code", () => {
  it("emails six digits and stores only their hash", async () => {
    const { service, prisma, messaging } = makeService();

    const issued = await service.issue({ purpose: "CITIZEN_SIGN_IN" as any, email: " Ravi@Example.COM " });

    expect(issued).toEqual({ otpRequestId: "otp_1", expiresInSeconds: 300 });
    const sent = messaging.send.mock.calls[0][1];
    expect(sent.to).toBe("ravi@example.com");
    const code = sent.subject.slice(0, 6);
    expect(code).toMatch(/^\d{6}$/);
    expect(sent.body).toContain(code);

    const stored = prisma.otpRequest.create.mock.calls[0][0].data;
    expect(stored.email).toBe("ravi@example.com");
    expect(stored.codeHash).toBe(sha(code));
    expect(JSON.stringify(stored)).not.toContain(`"${code}"`);
  });

  it("fails the request when the email could not be sent, and keeps no usable code", async () => {
    const { service, prisma } = makeService({ sendOk: false });

    await expectCode(service.issue({ purpose: "CITIZEN_SIGN_IN" as any, email: "a@b.in" }), "SERVICE_UNAVAILABLE");
    expect(prisma.otpRequest.delete).toHaveBeenCalledWith({ where: { id: "otp_1" } });
  });

  it("returns the code itself only under AUTH_DEV_BYPASS", async () => {
    const { service } = makeService({ env: { AUTH_DEV_BYPASS: true }, sendOk: false });

    const issued = await service.issue({ purpose: "CITIZEN_SIGN_IN" as any, email: "a@b.in" });
    expect(issued.devCode).toMatch(/^\d{6}$/);
  });

  it("refuses a second request inside the cooldown", async () => {
    const { service, messaging } = makeService({ recent: [new Date(Date.now() - 5_000)] });

    await expectCode(service.issue({ purpose: "CITIZEN_SIGN_IN" as any, email: "a@b.in" }), "RATE_LIMITED");
    expect(messaging.send).not.toHaveBeenCalled();
  });

  it("refuses the eleventh code in an hour", async () => {
    const recent = Array.from({ length: 10 }, (_, i) => new Date(Date.now() - (i + 1) * 60_000));
    const { service } = makeService({ recent });

    await expectCode(service.issue({ purpose: "CITIZEN_SIGN_IN" as any, email: "a@b.in" }), "RATE_LIMITED");
  });

  it("gives the store reviewer the fixed code and mails nothing", async () => {
    const { service, prisma, messaging } = makeService({
      env: { REVIEW_ACCOUNT_EMAIL: "review@smartparking.app", REVIEW_ACCOUNT_CODE: "246810" },
    });

    await service.issue({ purpose: "CITIZEN_SIGN_IN" as any, email: "Review@SmartParking.app" });

    expect(messaging.send).not.toHaveBeenCalled();
    expect(prisma.otpRequest.create.mock.calls[0][0].data.codeHash).toBe(sha("246810"));
  });
});

describe("checking a code", () => {
  it("accepts the right code once", async () => {
    const { service, prisma } = makeService();

    expect(await service.consume(row(), "123456")).toBe("ok");
    expect(prisma.otpRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "otp_1", consumedAt: null } }),
    );
  });

  it("counts a wrong guess", async () => {
    const { service, prisma } = makeService();

    expect(await service.consume(row(), "654321")).toBe("wrong");
    expect(prisma.otpRequest.update).toHaveBeenCalledWith({
      where: { id: "otp_1" },
      data: { attempts: { increment: 1 } },
    });
  });

  it("refuses a code that was already used, even by a concurrent request", async () => {
    const { service, prisma } = makeService();
    await expectCode(service.consume(row({ consumedAt: new Date() }), "123456"), "OTP_INVALID");

    prisma.otpRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    await expectCode(service.consume(row(), "123456"), "OTP_INVALID");
  });

  it("refuses an expired code and one out of guesses", async () => {
    const { service } = makeService();

    await expectCode(service.consume(row({ expiresAt: new Date(Date.now() - 1) }), "123456"), "OTP_INVALID");
    await expectCode(service.consume(row({ attempts: 5 }), "123456"), "RATE_LIMITED");
    await expectCode(service.consume(null, "123456"), "OTP_INVALID");
  });
});

describe("masking an address", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmail("ravi.kumar@gmail.com")).toBe("r•••••••••@gmail.com");
    expect(maskEmail("a@b.in")).toBe("a••@b.in");
  });
});
