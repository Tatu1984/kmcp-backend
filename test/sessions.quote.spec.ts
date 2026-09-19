import { describe, expect, it, vi } from "vitest";
import { SessionStatus, SlotType } from "@prisma/client";

import { SessionsService } from "../src/modules/sessions/sessions.service";
import { AppException } from "../src/common/errors/app.exception";
import type { AuthenticatedUser } from "../src/common/decorators/auth.decorators";

/**
 * The running fare, `GET /sessions/:id/quote`.
 *
 * This is the endpoint both apps poll: the citizen watches their own charge
 * tick up beside a local clock, the attendant reads the same figure to tell a
 * driver what they owe. Two things have to hold for that to be safe.
 *
 * A live estimate must never be mistaken for a settled charge, and a settled
 * charge must never be recomputed — the tariff can be republished between the
 * two calls, and a receipt that disagrees with itself is a dispute nobody can
 * close. And `session.read.own` opens the route to every signed-in citizen in
 * the city, so the row check is what keeps one citizen out of another's
 * parking; the permission cannot do it.
 */

/** Enough of Prisma's `where` grammar for the filter this service builds. */
function matches(row: Record<string, any>, where: any): boolean {
  if (where === undefined || where === null) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return (cond as any[]).some((c) => matches(row, c));
    if (key === "AND") return (cond as any[]).every((c) => matches(row, c));

    const value = row[key];
    if (cond === null || typeof cond !== "object") return value === cond;
    if ("in" in cond) return (cond.in as any[]).includes(value);
    return matches((value ?? {}) as Record<string, any>, cond);
  });
}

const HOUR = 3_600_000;

/** Parked two hours ago in Alipore, by a citizen who has claimed the plate. */
const MINE_LIVE = {
  id: "ses_mine",
  code: "KMCP-AAA111",
  status: SessionStatus.ACTIVE,
  zoneId: "zn_a",
  startAt: new Date(Date.now() - 2 * HOUR),
  endAt: null,
  durationMinutes: null,
  vehicleId: "veh_mine",
  grossAmount: null,
  discountAmount: 0,
  taxAmount: 0,
  penaltyAmount: 0,
  payableAmount: null,
  fareBreakdown: null,
  zone: { id: "zn_a", code: "ALP-01", name: "Alipore" },
  slot: { id: "slt_1", code: "A-12", type: SlotType.CAR },
  vehicleType: { code: SlotType.CAR, label: "Car" },
  vehicle: { ownerUserId: "usr_citizen" },
};

/** Somebody else's car, in the same zone. */
const THEIRS_LIVE = {
  ...MINE_LIVE,
  id: "ses_theirs",
  code: "KMCP-BBB222",
  vehicleId: "veh_theirs",
  vehicle: { ownerUserId: "usr_stranger" },
};

const STORED_QUOTE = {
  tariffId: "trf_1",
  tariffName: "Alipore CAR",
  tariffVersion: 1,
  durationMinutes: 120,
  chargeableMinutes: 110,
  gracePeriodMin: 10,
  lines: [
    { code: "BASE", label: "Base rate — first 60 minutes", amount: 2000 },
    { code: "INCREMENT", label: "2 × 30 minute block", amount: 1500 },
  ],
  grossAmount: 3500,
  discountAmount: 0,
  penaltyAmount: 0,
  taxAmount: 630,
  taxPercent: 18,
  payableAmount: 4130,
  cappedByDailyLimit: false,
  waivedByPass: false,
};

/** The same car, unparked and paid for. */
const MINE_SETTLED = {
  ...MINE_LIVE,
  id: "ses_settled",
  code: "KMCP-CCC333",
  status: SessionStatus.COMPLETED,
  endAt: new Date(Date.now() - HOUR),
  durationMinutes: 120,
  grossAmount: 3500,
  taxAmount: 630,
  payableAmount: 4130,
  fareBreakdown: STORED_QUOTE,
};

/** A completed session from the seeded history: amounts, and no breakdown behind them. */
const LEGACY_SETTLED = {
  ...MINE_SETTLED,
  id: "ses_legacy",
  code: "KMCP-DDD444",
  fareBreakdown: null,
};

const LIVE_QUOTE = { ...STORED_QUOTE, durationMinutes: 121, grossAmount: 3500, payableAmount: 4130 };

function makeService(rows: Record<string, any>[]) {
  const prisma: any = {
    parkingSession: {
      findFirst: vi.fn(async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null),
    },
    systemConfig: { findUnique: vi.fn().mockResolvedValue(null) },
  };

  const quotes = { quote: vi.fn().mockResolvedValue(LIVE_QUOTE) };
  const audit = { record: vi.fn() };
  const idempotency = { run: vi.fn() };

  const service = new SessionsService(prisma as any, audit as any, quotes as any, idempotency as any);
  return { service, prisma, quotes };
}

const CITIZEN: AuthenticatedUser = {
  id: "usr_citizen",
  role: "CITIZEN",
  isZoneScoped: false,
  name: "Citizen",
  zoneIds: [],
  sessionId: "sess_1",
};

/** A zone officer for Salt Lake. Alipore is not theirs. */
const OFFICER: AuthenticatedUser = {
  id: "usr_officer",
  role: "ZONE_OFFICER",
  isZoneScoped: true,
  name: "Zone Officer, Salt Lake",
  zoneIds: ["zn_b"],
  sessionId: "sess_2",
};

const ATTENDANT: AuthenticatedUser = {
  id: "usr_attendant",
  role: "ATTENDANT",
  isZoneScoped: true,
  name: "Attendant",
  zoneIds: ["zn_a"],
  attendantId: "att_1",
  sessionId: "sess_3",
};

async function expectRefusal(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe(code));
}

describe("a citizen asking what their own parking is costing", () => {
  it("prices the session as if it ended now, and says the figure is provisional", async () => {
    const { service, quotes } = makeService([MINE_LIVE]);

    const result: any = await service.quoteFor("ses_mine", CITIZEN);

    expect(result.provisional).toBe(true);
    expect(result.payableAmount).toBe(4130);
    expect(result.quote).toEqual(LIVE_QUOTE);

    // Priced to this instant, from the session's own start, zone and vehicle
    // type — the same inputs `end` passes, so the estimate and the eventual
    // charge come from one implementation.
    const input = quotes.quote.mock.calls[0][0];
    expect(input.zoneId).toBe("zn_a");
    expect(input.vehicleType).toBe(SlotType.CAR);
    expect(input.startAt).toBe(MINE_LIVE.startAt);
    expect(input.vehicleId).toBe("veh_mine");
    expect(input.endAt.getTime()).toBeGreaterThan(MINE_LIVE.startAt.getTime());
    expect(result.quotedAt).toEqual(input.endAt);
  });

  it("carries the bay and the running clock the app draws", async () => {
    const { service } = makeService([MINE_LIVE]);

    const result: any = await service.quoteFor("ses_mine", CITIZEN);

    expect(result.slot).toEqual({ id: "slt_1", code: "A-12", type: SlotType.CAR });
    expect(result.elapsedMinutes).toBe(120);
    expect(result.isOverstay).toBe(false);
  });

  it("flags an overstay from the same threshold the operations board uses", async () => {
    // Eight hours against the default six-hour grace. No SystemConfig row is
    // present, so this is the fallback — which has to match the one
    // SessionsService reads elsewhere, or the app and the board disagree about
    // whether a penalty is owed.
    const { service } = makeService([
      { ...MINE_LIVE, startAt: new Date(Date.now() - 8 * HOUR) },
    ]);

    const result: any = await service.quoteFor("ses_mine", CITIZEN);
    expect(result.isOverstay).toBe(true);
  });

  it("can be reached by the quotable code as well as the id", async () => {
    const { service } = makeService([MINE_LIVE]);
    const result: any = await service.quoteFor("KMCP-AAA111", CITIZEN);
    expect(result.sessionId).toBe("ses_mine");
  });

  it("refuses somebody else's session", async () => {
    const { service, quotes } = makeService([MINE_LIVE, THEIRS_LIVE]);

    // The row is found — `session.read.own` carries no row scope of its own and
    // a citizen is not zone-scoped, so nothing in the query keeps them out.
    // This refusal is the entire boundary.
    await expectRefusal(service.quoteFor("ses_theirs", CITIZEN), "FORBIDDEN");
    expect(quotes.quote).not.toHaveBeenCalled();
  });

  it("refuses a session it cannot find rather than saying whose it is", async () => {
    const { service } = makeService([MINE_LIVE]);
    await expectRefusal(service.quoteFor("ses_nonexistent", CITIZEN), "NOT_FOUND");
  });
});

describe("a session whose money has already been decided", () => {
  it("returns the stored breakdown instead of re-pricing it", async () => {
    const { service, quotes } = makeService([MINE_SETTLED]);

    const result: any = await service.quoteFor("ses_settled", CITIZEN);

    // The whole point: the fare engine is not called at all. Running it again
    // against a tariff that has since been republished would quietly disagree
    // with the receipt the citizen is holding.
    expect(quotes.quote).not.toHaveBeenCalled();
    expect(result.provisional).toBe(false);
    expect(result.quote).toEqual(STORED_QUOTE);
    expect(result.payableAmount).toBe(4130);
    expect(result.quotedAt).toEqual(MINE_SETTLED.endAt);
  });

  it("still answers with its amounts where no breakdown was ever stored", async () => {
    // Every completed session in the seeded history is like this, and so is any
    // row written before `fareBreakdown` existed. A null breakdown is the
    // honest answer; inventing one by re-pricing would move the money.
    const { service, quotes } = makeService([LEGACY_SETTLED]);

    const result: any = await service.quoteFor("ses_legacy", CITIZEN);

    expect(quotes.quote).not.toHaveBeenCalled();
    expect(result.quote).toBeNull();
    expect(result.payableAmount).toBe(4130);
    expect(result.provisional).toBe(false);
  });

  it("reports the charged duration rather than a clock still running", async () => {
    const { service } = makeService([MINE_SETTLED]);
    const result: any = await service.quoteFor("ses_settled", CITIZEN);

    expect(result.elapsedMinutes).toBe(120);
    expect(result.isOverstay).toBe(false);
  });

  it("answers with the same field names a live session does", async () => {
    const live: any = await makeService([MINE_LIVE]).service.quoteFor("ses_mine", CITIZEN);
    const settled: any = await makeService([MINE_SETTLED]).service.quoteFor("ses_settled", CITIZEN);

    // A client reads one shape and branches on `provisional`, not on which
    // fields happen to be present.
    expect(Object.keys(settled).sort()).toEqual(Object.keys(live).sort());
  });
});

describe("staff asking the same question", () => {
  it("lets an attendant read a session in their own zone", async () => {
    const { service } = makeService([MINE_LIVE]);
    const result: any = await service.quoteFor("ses_mine", ATTENDANT);
    expect(result.provisional).toBe(true);
  });

  it("does not check vehicle ownership for staff", async () => {
    // An attendant is not the owner of any car they park, so applying the
    // citizen rule to them would have closed the endpoint to the people who
    // need it most.
    const { service } = makeService([THEIRS_LIVE]);
    const result: any = await service.quoteFor("ses_theirs", ATTENDANT);
    expect(result.sessionId).toBe("ses_theirs");
  });

  it("keeps a zone officer out of another ward's session", async () => {
    // Reuses `findOne`'s scope rather than inventing a second rule, so an
    // officer's reach here is exactly their reach everywhere else.
    const { service } = makeService([MINE_LIVE]);
    await expectRefusal(service.quoteFor("ses_mine", OFFICER), "NOT_FOUND");
  });
});

describe("a session that is neither live nor completed", () => {
  it("reads a cancelled session's zeroed amounts rather than pricing it", async () => {
    const { service, quotes } = makeService([
      {
        ...MINE_LIVE,
        id: "ses_cancelled",
        status: SessionStatus.CANCELLED,
        endAt: new Date(Date.now() - HOUR),
        payableAmount: 0,
      },
    ]);

    const result: any = await service.quoteFor("ses_cancelled", CITIZEN);

    expect(quotes.quote).not.toHaveBeenCalled();
    expect(result.provisional).toBe(false);
    expect(result.payableAmount).toBe(0);
  });

  it("prices an overstaying session, which is still a car on the kerb", async () => {
    const { service, quotes } = makeService([
      { ...MINE_LIVE, status: SessionStatus.OVERSTAY, startAt: new Date(Date.now() - 8 * HOUR) },
    ]);

    const result: any = await service.quoteFor("ses_mine", CITIZEN);

    expect(quotes.quote).toHaveBeenCalled();
    expect(result.provisional).toBe(true);
    // The threshold reaches the fare engine, which is what makes the penalty
    // show up in the estimate before the driver is charged it.
    expect(quotes.quote.mock.calls[0][0].overstayAfterMinutes).toBe(360);
  });
});
