import { describe, expect, it, vi } from "vitest";
import { AuthEventType, UserStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";

import { AuthService } from "../src/modules/auth/auth.service";
import { AppException } from "../src/common/errors/app.exception";

/**
 * One handset per attendant, enforced at sign-in.
 *
 * The guard already turns away every request from an unbound handset, and a
 * supervisor can release a handset through `POST /attendants/:id/unbind-device`.
 * What was missing was the refusal in between: a second phone signing in used
 * to bind itself on the spot, and the first kept working. These cases pin the
 * login rule down, and pin down that it applies to attendants only — vendors
 * and admins sign in from the portal with no fingerprint and no binding.
 */

const PASSWORD = "correct-horse";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

const ATTENDANT = {
  id: "usr_att",
  name: "Ravi",
  email: "ravi@example.com",
  phone: "+919800000001",
  role: "ATTENDANT" as const,
  status: UserStatus.ACTIVE,
  passwordHash: PASSWORD_HASH,
  twoFactorEnabled: false,
  twoFactorSecret: null,
  vendor: null,
  attendant: { id: "att_1", vendorId: "ven_1" },
};

const VENDOR = {
  ...ATTENDANT,
  id: "usr_ven",
  name: "Ops Contractor",
  email: "ops@example.com",
  role: "VENDOR" as const,
  vendor: { id: "ven_1" },
  attendant: null,
};

const CTX = { ip: "127.0.0.1", geo: { source: "unknown" }, device: {} };

function makeService(user: Record<string, any>, activeDevices: { fingerprint: string }[] = []) {
  const prisma: any = {
    user: {
      findFirst: vi.fn().mockResolvedValue(user),
      findUniqueOrThrow: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockResolvedValue(user),
    },
    device: {
      // Answers the "is some other handset still bound?" query the way the
      // real table would: an active row whose fingerprint is not the one
      // being presented.
      findFirst: vi.fn(async ({ where }: any) => {
        const other = activeDevices.find((d) => d.fingerprint !== where.fingerprint.not);
        return other ? { id: `dev_${other.fingerprint}` } : null;
      }),
      upsert: vi.fn(async ({ create }: any) => ({ id: "dev_new", ...create })),
    },
    systemConfig: { create: vi.fn() },
  };

  const tokens = {
    issue: vi.fn().mockResolvedValue({ accessToken: "access", refreshToken: "refresh" }),
    sessionIdOf: vi.fn().mockReturnValue("sid_1"),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const events = {
    buildContext: vi.fn().mockResolvedValue(CTX),
    record: vi.fn().mockResolvedValue(undefined),
    detectAnomalies: vi.fn().mockResolvedValue({ anomalies: [], riskScore: 0 }),
    openSession: vi.fn().mockResolvedValue(undefined),
  };
  const config = { get: vi.fn().mockReturnValue("test") };
  const roles = { get: vi.fn() };

  const service = new AuthService(
    prisma as any,
    tokens as any,
    audit as any,
    events as any,
    config as any,
    roles as any,
  );
  return { service, prisma, tokens, events };
}

function login(service: AuthService, email: string, deviceFingerprint?: string) {
  return service.login(
    { email, password: PASSWORD, platform: "android", deviceFingerprint } as any,
    { header: () => undefined } as any,
  );
}

async function expectRefusal(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe(code));
}

describe("attendant device binding at login", () => {
  it("binds the handset on the first sign-in", async () => {
    const { service, prisma, tokens } = makeService(ATTENDANT);

    const result = await login(service, ATTENDANT.email, "phone-one-fingerprint");

    expect(result.status).toBe("authenticated");
    expect(prisma.device.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_fingerprint: { userId: "usr_att", fingerprint: "phone-one-fingerprint" } },
      }),
    );
    expect(tokens.issue).toHaveBeenCalledWith(expect.objectContaining({ id: "usr_att" }), "phone-one-fingerprint");
  });

  it("lets the bound handset sign in again", async () => {
    const { service, prisma, tokens } = makeService(ATTENDANT, [{ fingerprint: "phone-one-fingerprint" }]);

    const result = await login(service, ATTENDANT.email, "phone-one-fingerprint");

    expect(result.status).toBe("authenticated");
    expect(prisma.device.upsert).toHaveBeenCalledTimes(1);
    expect(tokens.issue).toHaveBeenCalledTimes(1);
  });

  it("refuses a second handset while the first is still bound", async () => {
    const { service, prisma, tokens, events } = makeService(ATTENDANT, [{ fingerprint: "phone-one-fingerprint" }]);

    await expectRefusal(login(service, ATTENDANT.email, "phone-two-fingerprint"), "DEVICE_NOT_BOUND");

    // The whole point: a refused sign-in binds nothing and issues nothing.
    expect(prisma.device.upsert).not.toHaveBeenCalled();
    expect(tokens.issue).not.toHaveBeenCalled();
    expect(events.openSession).not.toHaveBeenCalled();
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AuthEventType.LOGIN_FAILED,
        userId: "usr_att",
        identifierTried: ATTENDANT.email,
        failureReason: "Bound to another device",
      }),
    );
  });

  it("binds the replacement handset once a supervisor has released the old one", async () => {
    // After `unbind-device` the old row is `isActive: false`, so from the
    // rule's point of view there is no active device at all.
    const { service, prisma } = makeService(ATTENDANT, []);

    const result = await login(service, ATTENDANT.email, "phone-two-fingerprint");

    expect(result.status).toBe("authenticated");
    expect(prisma.device.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ fingerprint: "phone-two-fingerprint" }) }),
    );
  });

  it("applies the same rule to the self-service bind route", async () => {
    const { service, prisma } = makeService(ATTENDANT, [{ fingerprint: "phone-one-fingerprint" }]);

    await expectRefusal(
      service.bindDevice(
        { id: "usr_att", attendantId: "att_1" },
        { fingerprint: "phone-two-fingerprint", platform: "android" },
      ),
      "DEVICE_NOT_BOUND",
    );
    expect(prisma.device.upsert).not.toHaveBeenCalled();
  });

  it("leaves a vendor unaffected", async () => {
    // A vendor account has no attendant record; the rule never looks at it,
    // whether or not the portal happens to send a fingerprint.
    const { service, prisma, tokens } = makeService(VENDOR, [{ fingerprint: "laptop-one" }]);

    const bare = await login(service, VENDOR.email);
    expect(bare.status).toBe("authenticated");
    expect(prisma.device.findFirst).not.toHaveBeenCalled();

    const withFingerprint = await login(service, VENDOR.email, "laptop-two");
    expect(withFingerprint.status).toBe("authenticated");
    expect(prisma.device.findFirst).not.toHaveBeenCalled();
    expect(tokens.issue).toHaveBeenCalledTimes(2);
  });
});
