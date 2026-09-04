import { describe, expect, it, vi } from "vitest";
import { PaymentMode, SessionSource, SettlementStatus, SlotType, ZoneStatus } from "@prisma/client";

import { IdempotencyService } from "../src/common/services/idempotency.service";
import { SessionsService } from "../src/modules/sessions/sessions.service";
import { SettlementsService } from "../src/modules/settlements/settlements.service";

/**
 * Replaying a write.
 *
 * The connection between a handset at a kerb and this API drops constantly, and
 * an officer on a slow portal double-clicks. In both cases the request may well
 * have succeeded before the caller gave up on it, so the retry that follows is
 * not a new instruction — it is the same one, asked again.
 *
 * Payments have been safe from this since the beginning, on a unique key in the
 * database. These four routes were not: a retried start opened a second
 * session, a retried end priced the stay twice, a retried generate drafted a
 * second settlement, and a retried payout posted the same transfer to the
 * ledger again. Each case below is that second write not happening.
 */

const KEY = "idem-key-00000001";

/**
 * The real store, over an in-memory SystemConfig table.
 *
 * Deliberately not a stub: what is being tested is that a value written on the
 * first call is found and returned on the second, and a stub that always calls
 * through would pass while proving nothing.
 */
function makeStore() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    table: {
      findUnique: vi.fn(({ where }: any) =>
        rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null,
      ),
      upsert: vi.fn(({ where, create, update }: any) => {
        rows.set(where.key, rows.has(where.key) ? update.value : create.value);
        return { key: where.key, value: rows.get(where.key) };
      }),
      delete: vi.fn(({ where }: any) => {
        rows.delete(where.key);
        return { key: where.key };
      }),
    },
  };
}

// ------------------------------------------------------------------ sessions

const ZONE = {
  id: "zn_1",
  code: "PKS-01",
  name: "Park Street",
  status: ZoneStatus.OPEN,
  capacity: 10,
  boundary: null,
  centerLat: 22.5726,
  centerLng: 88.3639,
  allowedVehicleTypeIds: [SlotType.CAR, SlotType.TWO_WHEELER],
  vendorZones: [{ vendorId: "ven_1" }],
};

const ATTENDANT = {
  id: "usr_1",
  role: "ATTENDANT",
  attendantId: "att_1",
  vendorId: "ven_1",
  zoneIds: ["zn_1"],
  isZoneScoped: true,
  sessionId: "sess_1",
};

const START = {
  zoneId: "zn_1",
  plateNumber: "WB 02 AB 1234",
  vehicleType: SlotType.CAR,
  source: SessionSource.ATTENDANT_APP,
};

const LIVE = {
  id: "ses_1",
  code: "KMCP-AAA111",
  status: "ACTIVE",
  startAt: new Date("2026-08-06T10:00:00Z"),
  endAt: null,
  zoneId: "zn_1",
  slotId: null,
  vehicleId: "veh_1",
  vehicleTypeId: "vt_car",
  zone: { id: "zn_1", code: "PKS-01", name: "Park Street", boundary: null, centerLat: 22.5726, centerLng: 88.3639 },
};

const QUOTE = {
  tariffId: "trf_1",
  durationMinutes: 120,
  grossAmount: 3500,
  discountAmount: 0,
  taxAmount: 630,
  penaltyAmount: 0,
  payableAmount: 4130,
};

function makeSessions(store = makeStore()) {
  let nextId = 0;

  const prisma: any = {
    parkingSession: {
      findUnique: vi.fn().mockResolvedValue(null),
      // Nothing live for this plate; `end` overrides it to find the session.
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(({ data }: any) => {
        nextId += 1;
        return { id: `ses_${nextId}`, ...data };
      }),
      update: vi.fn().mockImplementation(({ data }: any) => ({ ...LIVE, ...data })),
    },
    zone: { findUnique: vi.fn().mockResolvedValue(ZONE) },
    vehicle: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "veh_1", plateNumber: "WB02AB1234" }),
    },
    vehicleType: { findUnique: vi.fn().mockResolvedValue({ id: "vt_car", code: SlotType.CAR }) },
    attendant: { findUnique: vi.fn().mockResolvedValue({ id: "att_1", vendorId: "ven_1" }) },
    shift: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
    slot: { update: vi.fn() },
    systemConfig: store.table,
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const quotes = { quote: vi.fn().mockResolvedValue(QUOTE) };

  return {
    service: new SessionsService(prisma, audit as any, quotes as any, new IdempotencyService(prisma)),
    prisma,
    quotes,
    store,
  };
}

describe("starting a session twice", () => {
  it("returns the original session for a repeated key", async () => {
    const { service, prisma } = makeSessions();

    const first: any = await service.start(START as any, ATTENDANT as any, { idempotencyKey: KEY });
    const second: any = await service.start(START as any, ATTENDANT as any, { idempotencyKey: KEY });

    expect(prisma.parkingSession.create).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
    expect(first.replayed).toBe(false);
  });

  it("still starts a second session under a different key", async () => {
    const { service, prisma } = makeSessions();

    await service.start(START as any, ATTENDANT as any, { idempotencyKey: KEY });
    await service.start(START as any, ATTENDANT as any, { idempotencyKey: "idem-key-00000002" });

    // A key is a promise about one request, not a lock on the route.
    expect(prisma.parkingSession.create).toHaveBeenCalledTimes(2);
  });

  it("does not hand one attendant another's session for the same key", async () => {
    const { service, prisma } = makeSessions();
    const other = { ...ATTENDANT, id: "usr_2", attendantId: "att_2" };

    const mine: any = await service.start(START as any, ATTENDANT as any, { idempotencyKey: KEY });
    const theirs: any = await service.start(START as any, other as any, { idempotencyKey: KEY });

    // Clients choose these keys, and two handsets will eventually choose the
    // same one. Sharing a scope would answer the second attendant with a
    // stranger's plate and location as if it were their own.
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.replayed).toBe(false);
    expect(prisma.parkingSession.create).toHaveBeenCalledTimes(2);
  });

  it("leaves a start with no key exactly as it was", async () => {
    const { service, prisma, store } = makeSessions();

    await service.start(START as any, ATTENDANT as any, {});
    await service.start(START as any, ATTENDANT as any, {});

    expect(prisma.parkingSession.create).toHaveBeenCalledTimes(2);
    expect(store.rows.size).toBe(0);
  });
});

describe("ending a session twice", () => {
  function endService() {
    const made = makeSessions();
    made.prisma.parkingSession.findFirst = vi.fn().mockResolvedValue(LIVE);
    return made;
  }

  it("returns the original fare for a repeated device event id", async () => {
    const { service, prisma, quotes } = endService();
    const dto = { clientEventId: "evt_00000001" };

    const first: any = await service.end("ses_1", dto as any, ATTENDANT as any, {});
    const second: any = await service.end("ses_1", dto as any, ATTENDANT as any, {});

    // The schema has accepted `clientEventId` on an end since the beginning and
    // nothing read it, so the offline queue's promise held for starts only.
    expect(quotes.quote).toHaveBeenCalledTimes(1);
    expect(prisma.parkingSession.update).toHaveBeenCalledTimes(1);
    expect(second.replayed).toBe(true);
    expect(second.payableAmount).toBe(first.payableAmount);
  });

  it("honours an Idempotency-Key from a client that sends no event id", async () => {
    const { service, quotes } = endService();

    await service.end("ses_1", {} as any, ATTENDANT as any, { idempotencyKey: KEY });
    await service.end("ses_1", {} as any, ATTENDANT as any, { idempotencyKey: KEY });

    // A second pricing run would bill the extra minutes between the two
    // attempts, which is a longer stay than the driver actually had.
    expect(quotes.quote).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------- settlements

const OFFICER = {
  id: "usr_officer",
  role: "ADMIN",
  attendantId: null,
  vendorId: null,
  zoneIds: [],
  isZoneScoped: false,
  sessionId: "sess_1",
};

const VENDOR = { id: "ven_1", orgName: "Metro Parking", commissionPct: 20 };

const PERIOD = {
  vendorId: "ven_1",
  periodStart: new Date("2026-07-01T00:00:00Z"),
  periodEnd: new Date("2026-07-31T23:59:59Z"),
};

const APPROVED = {
  id: "stl_1",
  vendorId: "ven_1",
  status: SettlementStatus.APPROVED,
  periodStart: PERIOD.periodStart,
  periodEnd: PERIOD.periodEnd,
  cashCollected: 5000,
  digitalCollected: 5000,
  vendorShare: 2000,
  governmentShare: 8000,
  _count: { lines: 2 },
};

function makeSettlements(overrides: Record<string, any> = {}) {
  const store = makeStore();
  const created: any[] = [];

  const prisma: any = {
    vendor: { findUnique: vi.fn().mockResolvedValue(VENDOR) },
    payment: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "pay_1", amount: 10_000, refundedAmount: 0, mode: PaymentMode.CASH }]),
    },
    settlement: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockImplementation(() => overrides.settlement ?? created.at(-1) ?? null),
      create: vi.fn().mockImplementation(({ data }: any) => {
        const row = { id: `stl_${created.length + 1}`, _count: { lines: 0 }, vendor: VENDOR, ...data };
        created.push(row);
        return row;
      }),
      update: vi.fn().mockImplementation(({ data }: any) => ({ ...(overrides.settlement ?? {}), ...data })),
    },
    settlementLine: { createMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([]) },
    ledgerEntry: { createMany: vi.fn().mockResolvedValue({ count: 2 }), findMany: vi.fn().mockResolvedValue([]) },
    systemConfig: store.table,
    $transaction: vi.fn(async (arg: any) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  return {
    service: new SettlementsService(prisma, audit as any, new IdempotencyService(prisma)),
    prisma,
  };
}

describe("generating a settlement twice", () => {
  it("drafts one settlement for a repeated key", async () => {
    const { service, prisma } = makeSettlements();

    const first: any = await service.generate(PERIOD as any, OFFICER as any, { idempotencyKey: KEY });
    const second: any = await service.generate(PERIOD as any, OFFICER as any, { idempotencyKey: KEY });

    // The unique constraint on (vendor, period) catches a re-run after the
    // first has landed. It cannot catch two requests in flight at once, which
    // is what a double-click on a slow connection produces.
    expect(prisma.settlement.create).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
  });
});

describe("recording a payout twice", () => {
  it("posts the transfer to the ledger once", async () => {
    const { service, prisma } = makeSettlements({ settlement: APPROVED });
    const dto = { reference: "UTR123456789", note: "NEFT" };

    const first: any = await service.payout("stl_1", dto as any, OFFICER as any, { idempotencyKey: KEY });
    const second: any = await service.payout("stl_1", dto as any, OFFICER as any, { idempotencyKey: KEY });

    // Two postings against a single bank transfer double-credit CASH_IN_HAND.
    // Nobody notices until an auditor reconciles the statement months later.
    expect(prisma.ledgerEntry.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.settlement.update).toHaveBeenCalledTimes(1);
    expect(second.replayed).toBe(true);
    expect(first.replayed).toBe(false);
  });

  it("refuses a second payout on its own once the first has landed", async () => {
    const { service, prisma } = makeSettlements({ settlement: APPROVED });

    await service.payout("stl_1", { reference: "UTR1234" } as any, OFFICER as any, {});
    prisma.settlement.findFirst = vi
      .fn()
      .mockResolvedValue({ ...APPROVED, status: SettlementStatus.PAID });

    // The status check remains the durable guard; the key only covers the
    // window before it can see anything.
    await expect(
      service.payout("stl_1", { reference: "UTR1234" } as any, OFFICER as any, {}),
    ).rejects.toThrow();
  });
});
