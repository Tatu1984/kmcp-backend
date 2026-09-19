import { describe, expect, it, vi } from "vitest";
import { PaymentMode, PaymentStatus, SessionStatus, SlotType } from "@prisma/client";

import { MeService } from "../src/modules/me/me.service";
import { AppException } from "../src/common/errors/app.exception";
import type { AuthenticatedUser } from "../src/common/decorators/auth.decorators";

/**
 * What the citizen app can actually render from `/me/*`.
 *
 * The flow these endpoints have to carry is: an attendant allocates a bay and
 * starts a session, the citizen opens the app and sees which bay their car is
 * in with a clock running against a provisional cost, and once it is unparked
 * the final total with the calculation behind it. None of that was reachable.
 * The payload had a total and a zone — no bay, so the app could not tell a
 * citizen where their own car was; no breakdown, so the total had nothing
 * behind it — and a live session's duration was hard-nulled, so the clock had
 * nowhere to start from.
 *
 * The claim route is here too, because it is the only way into all of the above
 * for the driver who never registered their plate: without it the session an
 * attendant just started for them belongs to nobody, and the app has a bay, a
 * timer and a fare it cannot attach to an account.
 */

const HOUR = 3_600_000;

/** Enough of Prisma's `where` grammar for the filters this service builds. */
function matches(row: Record<string, any>, where: any): boolean {
  if (where === undefined || where === null) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    const value = row[key];
    if (cond === null || typeof cond !== "object") return value === cond;
    if ("in" in cond) return (cond.in as any[]).includes(value);
    return matches((value ?? {}) as Record<string, any>, cond);
  });
}

const PAYMENT = {
  id: "pay_1",
  mode: PaymentMode.UPI_QR,
  status: PaymentStatus.CAPTURED,
  refundedAmount: 0,
  receipt: { id: "rcp_1", number: "RCPT/26-27/000001", issuedAt: new Date("2026-09-04T12:05:00Z") },
};

const BREAKDOWN = {
  tariffId: "trf_1",
  tariffName: "Alipore CAR",
  durationMinutes: 120,
  lines: [
    { code: "BASE", label: "Base rate — first 60 minutes", amount: 2000 },
    { code: "INCREMENT", label: "2 × 30 minute block", amount: 1500 },
  ],
  grossAmount: 3500,
  discountAmount: 0,
  penaltyAmount: 0,
  taxAmount: 630,
  payableAmount: 4130,
};

/** Parked ninety minutes ago, bay A-12, nothing charged yet. */
const LIVE = {
  id: "ses_live",
  code: "KMCP-AAA111",
  plateNumber: "WB02AB1234",
  status: SessionStatus.ACTIVE,
  startAt: new Date(Date.now() - 90 * 60_000),
  endAt: null,
  durationMinutes: null,
  grossAmount: null,
  discountAmount: 0,
  taxAmount: 0,
  penaltyAmount: 0,
  payableAmount: null,
  fareBreakdown: null,
  zone: { id: "zn_a", code: "ALP-01", name: "Alipore" },
  slot: { id: "slt_1", code: "A-12", type: SlotType.CAR },
  vehicleType: { code: SlotType.CAR, label: "Car" },
  payments: [],
  vehicle: { ownerUserId: "usr_citizen" },
};

/** The same car, unparked and paid for. */
const SETTLED = {
  ...LIVE,
  id: "ses_settled",
  code: "KMCP-CCC333",
  status: SessionStatus.COMPLETED,
  startAt: new Date(Date.now() - 4 * HOUR),
  endAt: new Date(Date.now() - 2 * HOUR),
  durationMinutes: 120,
  grossAmount: 3500,
  taxAmount: 630,
  payableAmount: 4130,
  fareBreakdown: BREAKDOWN,
  payments: [PAYMENT],
};

/** Promoted by the overstay sweep, which is exactly what `?status=ACTIVE` loses. */
const OVERSTAYING = {
  ...LIVE,
  id: "ses_overstay",
  code: "KMCP-BBB222",
  plateNumber: "WB02CD5678",
  status: SessionStatus.OVERSTAY,
  startAt: new Date(Date.now() - 8 * HOUR),
  slot: { id: "slt_9", code: "B-03", type: SlotType.CAR },
};

const CITIZEN: AuthenticatedUser = {
  id: "usr_citizen",
  role: "CITIZEN",
  isZoneScoped: false,
  name: "Citizen",
  zoneIds: [],
  sessionId: "sess_1",
};

function makeService(
  sessions: Record<string, any>[],
  vehicles: Record<string, any>[] = [],
) {
  // Copied, not referenced: `vehicle.update` writes into these rows, and a
  // fixture shared across cases would carry one test's claim into the next.
  const rows = vehicles.map((vehicle) => ({ ...vehicle }));

  const prisma: any = {
    parkingSession: {
      findMany: vi.fn(async ({ where }: any) =>
        sessions
          .filter((row) => matches(row, where))
          .sort((a, b) => b.startAt.getTime() - a.startAt.getTime()),
      ),
      findUnique: vi.fn(
        async ({ where }: any) => sessions.find((row) => row.code === where.code) ?? null,
      ),
    },
    vehicle: {
      findUnique: vi.fn(
        async ({ where }: any) => rows.find((v) => v.plateNumber === where.plateNumber) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const created = { id: "veh_new", ...data };
        rows.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((v) => v.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    vehicleType: { findUnique: vi.fn().mockResolvedValue({ id: "vt_car" }) },
    systemConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new MeService(prisma as any, audit as any);
  return { service, prisma, audit, vehicles: rows };
}

const PAGE = { page: 1, pageSize: 25 } as any;

async function expectRefusal(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe(code));
}

describe("a citizen's own session list", () => {
  it("carries the allocated bay", async () => {
    // The single biggest gap: a citizen could be told what their parking cost
    // but not where their car was.
    const [session]: any = await makeService([LIVE]).service.listSessions(PAGE, CITIZEN);
    expect(session.slot).toEqual({ id: "slt_1", code: "A-12", type: SlotType.CAR });
  });

  it("carries the fare breakdown and every amount behind the total", async () => {
    const [session]: any = await makeService([SETTLED]).service.listSessions(PAGE, CITIZEN);

    expect(session.fareBreakdown).toEqual(BREAKDOWN);
    expect(session.grossAmount).toBe(3500);
    expect(session.discountAmount).toBe(0);
    expect(session.taxAmount).toBe(630);
    expect(session.penaltyAmount).toBe(0);
    expect(session.payableAmount).toBe(4130);
    // 3500 + 630 is the 4130 on the screen — the app can now show the citizen
    // that arithmetic rather than one unexplained figure.
    expect(session.grossAmount + session.taxAmount).toBe(session.payableAmount);
  });

  it("names the vehicle type the way the rest of the API does", async () => {
    const [session]: any = await makeService([LIVE]).service.listSessions(PAGE, CITIZEN);
    expect(session.vehicleType).toEqual({ code: SlotType.CAR, label: "Car" });
  });

  it("reports a running clock for a live session instead of nothing", async () => {
    const [session]: any = await makeService([LIVE]).service.listSessions(PAGE, CITIZEN);

    expect(session.elapsedMinutes).toBe(90);
    expect(session.isOverstay).toBe(false);
    // Still null, and correctly so: nothing has been charged, and this is the
    // duration a fare was computed on. `elapsedMinutes` is what ticks.
    expect(session.durationMinutes).toBeNull();
  });

  it("keeps the charged duration for a finished session", async () => {
    const [session]: any = await makeService([SETTLED]).service.listSessions(PAGE, CITIZEN);

    // Read from the column the fare was computed on, not recomputed from the
    // timestamps — the engine rounds a part minute up, so the two disagree.
    expect(session.durationMinutes).toBe(120);
    expect(session.elapsedMinutes).toBe(120);
    expect(session.isOverstay).toBe(false);
  });

  it("flags an overstaying session from the shared threshold", async () => {
    const [session]: any = await makeService([OVERSTAYING]).service.listSessions(PAGE, CITIZEN);
    expect(session.isOverstay).toBe(true);
  });

  it("is scoped to the caller's own vehicles and nothing else", async () => {
    const { service, prisma } = makeService([LIVE]);
    await service.listSessions(PAGE, CITIZEN);

    expect(prisma.parkingSession.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ vehicle: { ownerUserId: "usr_citizen" } }),
    );
  });

  it("stays a citizen payload, not a staff one", async () => {
    const [session]: any = await makeService([SETTLED]).service.listSessions(PAGE, CITIZEN);

    // Widening this to everything the portal sees would have handed the public
    // app the operator, the attendant and the evidence trail for a session.
    for (const field of ["vendor", "attendant", "shiftId", "evidenceStartMediaId", "startLat"]) {
      expect(session).not.toHaveProperty(field);
    }
  });

  it("carries the settling payment and its receipt", async () => {
    const [session]: any = await makeService([SETTLED]).service.listSessions(PAGE, CITIZEN);

    expect(session.payment).toEqual({ id: "pay_1", mode: PaymentMode.UPI_QR, status: PaymentStatus.CAPTURED });
    expect(session.receipt).toEqual(PAYMENT.receipt);
    expect(session.refundedAmount).toBe(0);
  });
});

describe("what am I parked in right now", () => {
  it("returns both a live and an overstaying session", async () => {
    // The bug this route exists for: an app polling `?status=ACTIVE` watched
    // its own session vanish the moment the sweep promoted it to OVERSTAY,
    // six hours in, when the driver most needed to see it.
    const sessions: any = await makeService([LIVE, OVERSTAYING, SETTLED]).service.listActiveSessions(
      CITIZEN,
    );

    expect(sessions.map((s: any) => s.status).sort()).toEqual([
      SessionStatus.ACTIVE,
      SessionStatus.OVERSTAY,
    ]);
  });

  it("leaves finished sessions out of it", async () => {
    const sessions: any = await makeService([SETTLED]).service.listActiveSessions(CITIZEN);
    expect(sessions).toEqual([]);
  });

  it("puts the newest first", async () => {
    // Two of the citizen's cars are parked at once, which one live session per
    // plate does not prevent. The one they just parked is the one they want.
    const sessions: any = await makeService([OVERSTAYING, LIVE]).service.listActiveSessions(CITIZEN);
    expect(sessions.map((s: any) => s.id)).toEqual(["ses_live", "ses_overstay"]);
  });

  it("answers in the same shape the list does", async () => {
    const [fromList]: any = await makeService([LIVE]).service.listSessions(PAGE, CITIZEN);
    const [fromActive]: any = await makeService([LIVE]).service.listActiveSessions(CITIZEN);
    expect(Object.keys(fromActive).sort()).toEqual(Object.keys(fromList).sort());
  });

  it("is scoped to the caller's own vehicles", async () => {
    const { service, prisma } = makeService([LIVE]);
    await service.listActiveSessions(CITIZEN);

    expect(prisma.parkingSession.findMany.mock.calls[0][0].where.vehicle).toEqual({
      ownerUserId: "usr_citizen",
    });
  });
});

describe("claiming a session by its code", () => {
  const UNOWNED = { id: "veh_1", plateNumber: "WB02AB1234", ownerUserId: null };
  const MINE = { ...UNOWNED, ownerUserId: "usr_citizen" };
  const SOMEONE_ELSES = { ...UNOWNED, ownerUserId: "usr_stranger" };

  it("takes ownership of an unclaimed plate", async () => {
    const { service, vehicles, audit } = makeService([LIVE], [UNOWNED]);

    const claimed: any = await service.claimSession({ code: "KMCP-AAA111" }, CITIZEN, {});

    // The claim is on the vehicle: that is what makes this session, the ones
    // before it and the ones after visible to this account.
    expect(vehicles[0].ownerUserId).toBe("usr_citizen");
    expect(claimed.id).toBe("ses_live");
    expect(claimed.slot).toEqual({ id: "slt_1", code: "A-12", type: SlotType.CAR });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SESSION_CLAIM", entityId: "ses_live" }),
    );
  });

  it("answers in the same shape the session list does", async () => {
    const [fromList]: any = await makeService([LIVE]).service.listSessions(PAGE, CITIZEN);
    const claimed: any = await makeService([LIVE], [UNOWNED]).service.claimSession(
      { code: "KMCP-AAA111" },
      CITIZEN,
      {},
    );
    // So the app renders the claimed session from this response with no second
    // round trip.
    expect(Object.keys(claimed).sort()).toEqual(Object.keys(fromList).sort());
  });

  it("succeeds again for a plate this citizen already owns", async () => {
    const { service, prisma } = makeService([LIVE], [MINE]);

    const claimed: any = await service.claimSession({ code: "KMCP-AAA111" }, CITIZEN, {});

    expect(claimed.id).toBe("ses_live");
    // Idempotent: a second tap re-claims nothing and writes nothing.
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
  });

  it("refuses a plate registered to another account, without saying whose", async () => {
    const { service, vehicles } = makeService([LIVE], [SOMEONE_ELSES]);

    const failure: any = await service
      .claimSession({ code: "KMCP-AAA111" }, CITIZEN, {})
      .catch((error: AppException) => error);

    expect(failure).toBeInstanceOf(AppException);
    expect(failure.code).toBe("DUPLICATE_RESOURCE");
    expect(JSON.stringify(failure.getResponse())).not.toContain("usr_stranger");
    expect(vehicles[0].ownerUserId).toBe("usr_stranger");
  });

  it("accepts a lowercase code typed by hand", async () => {
    const { service } = makeService([LIVE], [UNOWNED]);
    const claimed: any = await service.claimSession({ code: " kmcp-aaa111 " }, CITIZEN, {});
    expect(claimed.id).toBe("ses_live");
  });

  it("does not say whether an unknown code exists", async () => {
    const { service } = makeService([LIVE], [UNOWNED]);
    await expectRefusal(service.claimSession({ code: "KMCP-ZZZ999" }, CITIZEN, {}), "NOT_FOUND");
  });

  it("claims a session that ended a few minutes ago", async () => {
    // The driver who paid at the kerb and opened the app on the walk back still
    // needs to reach their receipt.
    const justEnded = {
      ...SETTLED,
      endAt: new Date(Date.now() - 10 * 60_000),
      code: "KMCP-CCC333",
    };
    const { service, vehicles } = makeService([justEnded], [UNOWNED]);

    await service.claimSession({ code: "KMCP-CCC333" }, CITIZEN, {});
    expect(vehicles[0].ownerUserId).toBe("usr_citizen");
  });

  it("refuses a session that ended days ago", async () => {
    // A six-character code from a 32-letter alphabet is guessable given enough
    // attempts. The window is what stops a guess reaching a stranger's history.
    const old = { ...SETTLED, endAt: new Date(Date.now() - 72 * HOUR) };
    const { service, vehicles } = makeService([old], [UNOWNED]);

    await expectRefusal(
      service.claimSession({ code: "KMCP-CCC333" }, CITIZEN, {}),
      "SESSION_NOT_ACTIVE",
    );
    expect(vehicles[0].ownerUserId).toBeNull();
  });

  it("refuses a cancelled session, which has nothing to claim", async () => {
    const cancelled = {
      ...SETTLED,
      status: SessionStatus.CANCELLED,
      endAt: new Date(Date.now() - 60_000),
      payableAmount: 0,
    };
    const { service } = makeService([cancelled], [UNOWNED]);

    await expectRefusal(
      service.claimSession({ code: "KMCP-CCC333" }, CITIZEN, {}),
      "SESSION_NOT_ACTIVE",
    );
  });

  it("claims an overstaying session, which is still a car on the kerb", async () => {
    const { service, vehicles } = makeService([OVERSTAYING], [
      { id: "veh_2", plateNumber: "WB02CD5678", ownerUserId: null },
    ]);

    await service.claimSession({ code: "KMCP-BBB222" }, CITIZEN, {});
    expect(vehicles[0].ownerUserId).toBe("usr_citizen");
  });
});
