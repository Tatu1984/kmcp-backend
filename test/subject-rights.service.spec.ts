import { describe, expect, it, vi } from "vitest";
import { PassStatus, SessionStatus, UserStatus } from "@prisma/client";

import { SubjectRightsService } from "../src/modules/privacy/subject-rights.service";
import { AppException } from "../src/common/errors/app.exception";

/**
 * Erasure is where a citizen's right runs into the authority's obligation, and
 * the answer is not the one the word suggests. Deleting the rows would leave a
 * settlement whose lines do not add up and a ledger entry pointing at a
 * transaction that no longer exists — the authority would have destroyed its
 * own accounts to honour a request it could have honoured properly.
 *
 * So these tests are mostly about what *survives*: the sessions, the payments
 * and the receipts stay, attached to an account that names nobody.
 */

const CITIZEN = {
  id: "usr_1",
  name: "Ananya Bose",
  phone: "+919830000001",
  email: "ananya@example.com",
  status: UserStatus.ACTIVE,
  role: "CITIZEN",
  twoFactorEnabled: false,
  createdAt: new Date("2025-01-04T00:00:00.000Z"),
  updatedAt: new Date("2026-01-04T00:00:00.000Z"),
  lastLoginAt: new Date("2026-08-04T00:00:00.000Z"),
};

const OFFICER = {
  id: "usr_officer",
  name: "R. Sen",
  role: "ADMIN",
  isZoneScoped: false,
  zoneIds: [],
  sessionId: "sid_1",
} as never;

interface Counts {
  inFlight?: number;
  openIncidents?: number;
  pendingPayments?: number;
  livePasses?: number;
}

function makeService(counts: Counts = {}, overrides: Record<string, unknown> = {}) {
  const collection = (rows: unknown[] = []) => ({
    findMany: vi.fn().mockResolvedValue(rows),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    update: vi.fn().mockImplementation(({ data }: never) => data),
  });

  const prisma: Record<string, ReturnType<typeof collection>> & { $transaction?: unknown } = {
    user: collection(),
    vehicle: collection([{ id: "veh_1" }]),
    parkingSession: collection(
      (overrides.sessions as unknown[]) ?? [
        { evidenceStartMediaId: "med_1", evidenceEndMediaId: "med_2" },
      ],
    ),
    incident: collection(),
    payment: collection(),
    pass: collection(),
    feedback: collection(),
    notification: collection(),
    device: collection(),
    favourite: collection(),
    loginSession: collection(),
    trustedLoginLocation: collection(),
    locationConsent: collection(),
    consentRecord: collection(),
    authEvent: collection(),
  };

  prisma.user.findFirst = vi.fn().mockResolvedValue(CITIZEN);
  prisma.parkingSession.count = vi.fn().mockResolvedValue(counts.inFlight ?? 0);
  prisma.incident.count = vi.fn().mockResolvedValue(counts.openIncidents ?? 0);
  prisma.payment.count = vi.fn().mockResolvedValue(counts.pendingPayments ?? 0);
  prisma.pass.count = vi.fn().mockResolvedValue(counts.livePasses ?? 0);
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const retention = {
    destroyEvidence: vi.fn().mockResolvedValue({ destroyed: 2, heldBack: 0, remaining: 0 }),
  };

  const service = new SubjectRightsService(prisma as never, audit as never, retention as never);
  return { service, prisma, audit, retention };
}

const ERASE = { reason: "Citizen request DPDP/2026/114", confirmCitizenId: "usr_1" };

describe("refusing an erasure that would strand a transaction", () => {
  it("refuses while a session is live, in overstay or disputed", async () => {
    const { service, prisma } = makeService({ inFlight: 1 });

    await expect(service.erase("usr_1", ERASE, OFFICER, {})).rejects.toBeInstanceOf(AppException);
    // Nothing partial: the account is untouched, not half-erased.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses while a payment has not been captured", async () => {
    const { service } = makeService({ pendingPayments: 2 });
    await expect(service.erase("usr_1", ERASE, OFFICER, {})).rejects.toThrow();
  });

  it("refuses while a pass they paid for is still valid", async () => {
    const { service } = makeService({ livePasses: 1 });
    await expect(service.erase("usr_1", ERASE, OFFICER, {})).rejects.toThrow();
  });

  it("lists every blocker at once rather than one per attempt", async () => {
    const { service } = makeService({ inFlight: 1, openIncidents: 2, pendingPayments: 3 });

    const error = await service.erase("usr_1", ERASE, OFFICER, {}).catch((e: AppException) => e);
    const body = (error as AppException).getResponse() as { details: { field: string }[] };

    // Being told to close a dispute, and then on the second attempt that there
    // is also an unpaid session, is how a five-minute job becomes a week of
    // correspondence.
    expect(body.details.map((d) => d.field).sort()).toEqual(["incidents", "payments", "sessions"]);
  });
});

describe("erasing an account that is clear", () => {
  it("clears the identifiers and marks the account deleted", async () => {
    const { service, prisma } = makeService();

    await service.erase("usr_1", ERASE, OFFICER, {});

    const [call] = prisma.user.update.mock.calls;
    expect(call[0].data).toMatchObject({
      email: null,
      phone: null,
      passwordHash: null,
      twoFactorSecret: null,
      twoFactorEnabled: false,
      status: UserStatus.INACTIVE,
    });
    expect(call[0].data.name).not.toContain("Ananya");
    expect(call[0].data.deletedAt).toBeInstanceOf(Date);
  });

  it("unclaims the vehicles rather than rewriting the plates", async () => {
    const { service, prisma } = makeService();

    await service.erase("usr_1", ERASE, OFFICER, {});

    // A plate identifies a vehicle, and that vehicle may be parked by somebody
    // else tomorrow. Severing the owner is what makes the sessions stop being
    // personal data; rewriting the plate would corrupt the vendor's settlement.
    expect(prisma.vehicle.updateMany).toHaveBeenCalledWith({
      where: { ownerUserId: "usr_1" },
      data: { ownerUserId: null },
    });
  });

  it("leaves every financial record alone", async () => {
    const { service, prisma } = makeService();

    await service.erase("usr_1", ERASE, OFFICER, {});

    // The whole design in one assertion. Sessions, payments, receipts and
    // passes are tax and accounting records; they survive and now refer to an
    // account that identifies nobody.
    expect(prisma.parkingSession.deleteMany).not.toHaveBeenCalled();
    expect(prisma.parkingSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(prisma.pass.deleteMany).not.toHaveBeenCalled();
  });

  it("redacts the delivery log without deleting it", async () => {
    const { service, prisma } = makeService();

    await service.erase("usr_1", ERASE, OFFICER, {});

    // Channel, template, status and timing survive — that log is what a breach
    // notification would be assembled from. The payload, which carried the
    // number, the plate and the amount, does not.
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
    expect(prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payload: expect.objectContaining({ redacted: true }) }),
      }),
    );
  });

  it("deletes the handsets and the home-and-office labels", async () => {
    const { service, prisma } = makeService();

    await service.erase("usr_1", ERASE, OFFICER, {});

    expect(prisma.device.deleteMany).toHaveBeenCalled();
    expect(prisma.favourite.deleteMany).toHaveBeenCalled();
    // An erased account must not remain signed in anywhere.
    expect(prisma.loginSession.deleteMany).toHaveBeenCalled();
  });

  it("strips the name and the precise fixes from sign-in records", async () => {
    const { service, prisma } = makeService();

    await service.erase("usr_1", ERASE, OFFICER, {});

    expect(prisma.authEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userName: null,
          identifierTried: null,
          gpsLatitude: null,
        }),
      }),
    );
  });

  it("destroys their evidence photographs, subject to the same holds", async () => {
    const { service, retention } = makeService();

    const result = await service.erase("usr_1", ERASE, OFFICER, {});

    expect(retention.destroyEvidence).toHaveBeenCalledWith(["med_1", "med_2"]);
    expect(result.evidenceFilesDestroyed).toBe(2);
  });

  it("audits the officer without copying what was destroyed", async () => {
    const { service, audit } = makeService();

    await service.erase("usr_1", ERASE, OFFICER, {});

    const entry = audit.record.mock.calls.map((c) => c[0]).find((e) => e.action === "DATA_SUBJECT_ERASURE");
    expect(entry).toMatchObject({ entity: "User", entityId: "usr_1", actor: OFFICER });

    // The name and number are the things that were just destroyed, so they are
    // exactly what must not reappear in a row kept for seven years.
    const serialised = JSON.stringify(entry.before) + JSON.stringify(entry.after);
    expect(serialised).not.toContain(CITIZEN.phone);
    expect(serialised).not.toContain(CITIZEN.email);
    expect(serialised).toContain(ERASE.reason);
  });
});

describe("export", () => {
  it("audits the disclosure against the officer who asked", async () => {
    const { service, audit } = makeService();

    await service.export("usr_1", OFFICER, { ip: "203.0.113.4", requestId: "req_9" });

    const entry = audit.record.mock.calls.map((c) => c[0]).find((e) => e.action === "DATA_SUBJECT_EXPORT");
    expect(entry).toMatchObject({ entityId: "usr_1", actor: OFFICER, ip: "203.0.113.4" });
  });

  it("lists evidence as media ids rather than signed links", async () => {
    const { service } = makeService(
      {},
      {
        sessions: [
          {
            id: "ses_1",
            status: SessionStatus.COMPLETED,
            evidenceStartMediaId: "med_1",
            evidenceEndMediaId: null,
          },
        ],
      },
    );

    const pack = await service.export("usr_1", OFFICER, {});

    // A signed URL is a bearer credential that outlives the response and would
    // sit in whatever inbox this package was forwarded to.
    expect(pack.evidenceMediaIds).toEqual(["med_1"]);
    expect(JSON.stringify(pack)).not.toContain("http");
  });

  it("says when a section was truncated", async () => {
    const { service } = makeService();
    const pack = await service.export("usr_1", OFFICER, {});

    // A silently short export is a worse answer to a subject-access request
    // than an honest partial one.
    expect(pack.meta.truncated).toMatchObject({ sessions: false });
    expect(pack.meta.rowLimitPerSection).toBeGreaterThan(0);
  });
});

describe("correction", () => {
  it("records both sides of the change", async () => {
    const { service, prisma, audit } = makeService();
    prisma.user.update = vi.fn().mockResolvedValue({
      id: "usr_1",
      name: "Ananya Bose",
      phone: "+919830000009",
      email: CITIZEN.email,
      status: UserStatus.ACTIVE,
      updatedAt: new Date(),
    });

    await service.correct(
      "usr_1",
      { phone: "+919830000009", reason: "Number transcribed wrongly at sign-up" },
      OFFICER,
      {},
    );

    const entry = audit.record.mock.calls
      .map((c) => c[0])
      .find((e) => e.action === "DATA_SUBJECT_CORRECTION");
    // A correction that cannot be shown to have been a correction is
    // indistinguishable from tampering with somebody's account.
    expect(entry.before.phone).toBe(CITIZEN.phone);
    expect(entry.after.phone).toBe("+919830000009");
  });

  it("can clear a field as well as change it", async () => {
    const { service, prisma } = makeService();

    await service.correct("usr_1", { email: null, reason: "Address belongs to nobody" }, OFFICER, {});

    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ email: null });
  });
});

describe("passes that are no longer live", () => {
  it("does not block erasure", async () => {
    // Counted with `status: ACTIVE` and `validTo >= now`, so an expired pass is
    // not a reason to keep somebody's name on file.
    const { service } = makeService({ livePasses: 0 });
    await expect(service.erase("usr_1", ERASE, OFFICER, {})).resolves.toMatchObject({
      erased: true,
    });
    expect(PassStatus.EXPIRED).toBe("EXPIRED");
  });
});
