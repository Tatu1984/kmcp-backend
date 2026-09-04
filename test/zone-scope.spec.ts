import { describe, expect, it } from "vitest";
import { SessionStatus, SlotStatus, SlotType, ZoneStatus } from "@prisma/client";

import { SessionsService } from "../src/modules/sessions/sessions.service";
import { SlotsService } from "../src/modules/slots/slots.service";
import { ZonesService } from "../src/modules/zones/zones.service";
import { AppException } from "../src/common/errors/app.exception";
import type { AuthenticatedUser } from "../src/common/decorators/auth.decorators";

/**
 * Zone scope, tested as rows rather than as intent.
 *
 * `RbacGuard` answers "may you call this?". It never answers "may you see this
 * row?", and it says so in its own comment — the services are expected to do
 * that themselves. A zone officer for Alipore holds `zone.read` and
 * `session.read` exactly as a zone officer for Salt Lake does; the only thing
 * standing between the two is a `where` clause.
 *
 * So the double below does not record the filter it was handed and assert on
 * its shape — a service can build a beautiful filter and then not use it, or
 * build one that a later spread overwrites. It applies the filter to real rows
 * and hands back what survives. The question each test asks is the one that
 * matters: did zone B's data come back?
 */

// ------------------------------------------------------- a prisma that filters

type Row = Record<string, any>;

/** Enough of Prisma's `where` grammar for the filters these services build. */
function matches(row: Row, where: any): boolean {
  if (where === undefined || where === null) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return (cond as any[]).some((c) => matches(row, c));
    if (key === "AND") return (cond as any[]).every((c) => matches(row, c));
    if (key === "NOT") return !matches(row, cond);

    const value = row[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return value === cond;
    if ("in" in cond) return (cond.in as any[]).includes(value);
    if ("notIn" in cond) return !(cond.notIn as any[]).includes(value);
    if ("contains" in cond) return String(value ?? "").includes(String(cond.contains));
    if ("gte" in cond || "lte" in cond || "gt" in cond || "lt" in cond) {
      const n = value instanceof Date ? value.getTime() : Number(value);
      const bound = (b: any) => (b instanceof Date ? b.getTime() : Number(b));
      if ("gte" in cond && !(n >= bound(cond.gte))) return false;
      if ("gt" in cond && !(n > bound(cond.gt))) return false;
      if ("lte" in cond && !(n <= bound(cond.lte))) return false;
      if ("lt" in cond && !(n < bound(cond.lt))) return false;
      return true;
    }
    // A relation filter, e.g. `{ session: { zoneId: { in: [...] } } }`.
    return matches((value ?? {}) as Row, cond);
  });
}

function table(rows: Row[]) {
  const found = (args: any = {}) => rows.filter((row) => matches(row, args.where));
  return {
    findMany: async (args: any = {}) => found(args),
    findFirst: async (args: any = {}) => found(args)[0] ?? null,
    findUnique: async (args: any = {}) => found(args)[0] ?? null,
    count: async (args: any = {}) => found(args).length,
    groupBy: async (args: any) => {
      const field = args.by[0];
      const counts = new Map<unknown, number>();
      for (const row of found(args)) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
      return [...counts].map(([key, n]) => ({ [field]: key, _count: { _all: n } }));
    },
  };
}

// ---------------------------------------------------------------- the kerb

const ZONE_A = {
  id: "zn_a",
  code: "ALP-01",
  name: "Alipore Road",
  wardId: "wd_1",
  streetId: "st_1",
  centerLat: 22.53,
  centerLng: 88.33,
  boundary: null,
  capacity: 10,
  allowedVehicleTypeIds: [SlotType.CAR],
  openTime: null,
  closeTime: null,
  status: ZoneStatus.OPEN,
  closureReason: null,
  closureUntil: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ward: { id: "wd_1", code: "W1", name: "Ward 1" },
  street: { id: "st_1", name: "Alipore Road" },
  vendorZones: [],
  _count: { slots: 1, sessions: 1 },
};

const ZONE_B = {
  ...ZONE_A,
  id: "zn_b",
  code: "SLT-01",
  name: "Salt Lake Sector V",
  wardId: "wd_2",
  street: { id: "st_2", name: "Salt Lake Sector V" },
};

const SLOT_A = {
  id: "slt_a",
  zoneId: "zn_a",
  code: "A-01",
  type: SlotType.CAR,
  status: SlotStatus.AVAILABLE,
  isReserved: false,
  zone: { id: "zn_a", code: "ALP-01", name: "Alipore Road" },
};

const SLOT_B = {
  ...SLOT_A,
  id: "slt_b",
  zoneId: "zn_b",
  code: "B-01",
  zone: { id: "zn_b", code: "SLT-01", name: "Salt Lake Sector V" },
};

const SESSION_A = {
  id: "ses_a",
  code: "KMCP-AAA111",
  zoneId: "zn_a",
  vendorId: "ven_1",
  attendantId: "att_1",
  plateNumber: "WB02AB1234",
  status: SessionStatus.ACTIVE,
  startAt: new Date("2026-09-04T09:00:00.000Z"),
  endAt: null,
  durationMinutes: null,
  payableAmount: null,
  payments: [],
  incidents: [],
};

const SESSION_B = {
  ...SESSION_A,
  id: "ses_b",
  code: "KMCP-BBB222",
  zoneId: "zn_b",
  plateNumber: "WB02CD5678",
};

function makePrisma() {
  const prisma: any = {
    zone: table([ZONE_A, ZONE_B]),
    slot: table([SLOT_A, SLOT_B]),
    parkingSession: table([SESSION_A, SESSION_B]),
    systemConfig: { findUnique: async () => null },
  };
  prisma.$transaction = async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg);
  return prisma;
}

const audit = { record: async () => undefined } as any;

/** Neither `list` nor `findOne` replays anything; this is here for the ctor. */
const idempotency = { run: async (_key: string, fn: () => unknown) => fn() } as any;

const zones = () => new ZonesService(makePrisma(), audit);
const slots = () => new SlotsService(makePrisma(), audit);
const sessions = () =>
  new SessionsService(makePrisma(), audit, { quote: async () => ({}) } as any, idempotency);

/** A zone officer for Alipore. Salt Lake is not theirs. */
const OFFICER: AuthenticatedUser = {
  id: "usr_officer",
  role: "ZONE_OFFICER",
  isZoneScoped: true,
  name: "Zone Officer, Alipore",
  zoneIds: ["zn_a"],
  sessionId: "ses_1",
};

const ADMIN: AuthenticatedUser = {
  id: "usr_admin",
  role: "ADMIN",
  isZoneScoped: false,
  name: "Administrator",
  zoneIds: [],
  sessionId: "ses_2",
};

const PAGE = { page: 1, pageSize: 20 } as any;

async function expectNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe("NOT_FOUND"));
}

// ------------------------------------------------------------------- zones

describe("what a zone officer can see of the zones", () => {
  it("lists only the zones assigned to them", async () => {
    const page: any = await zones().list(PAGE, OFFICER);
    expect(page.items.map((z: any) => z.id)).toEqual(["zn_a"]);
  });

  it("counts only their zones, so they cannot page past the filter", async () => {
    const page: any = await zones().list(PAGE, OFFICER);
    // The total is what the portal uses to decide there is a next page. If the
    // filter were applied after the query this would say 2 and the second page
    // would show Salt Lake.
    expect(page.total).toBe(1);
  });

  it("is not handed another zone's row when it asks for one", async () => {
    // Not a leak — `zn_b` never comes back — but see the known gap below for
    // what does.
    const zone: any = await zones().findOne("zn_b", OFFICER).catch(() => null);
    expect(zone?.id).not.toBe("zn_b");
  });

  it("can open one that is", async () => {
    const zone: any = await zones().findOne("zn_a", OFFICER);
    expect(zone.id).toBe("zn_a");
  });

  it("does not filter an unscoped role", async () => {
    // The other half of the assertion: the filter is driven by the scope, not
    // applied to everybody.
    const page: any = await zones().list(PAGE, ADMIN);
    expect(page.items.map((z: any) => z.id).sort()).toEqual(["zn_a", "zn_b"]);
  });
});

// ---------------------------------------------------------------- sessions

describe("what a zone officer can see of the sessions", () => {
  it("lists only sessions in their zones", async () => {
    const page: any = await sessions().list(PAGE, OFFICER);
    expect(page.items.map((s: any) => s.id)).toEqual(["ses_a"]);
    expect(page.total).toBe(1);
  });

  it("cannot open a session from another zone by id", async () => {
    await expectNotFound(sessions().findOne("ses_b", OFFICER));
  });

  it("cannot open one by its human-readable code either", async () => {
    // `findOne` accepts either, and the `OR: [{ id }, { code }]` is spread
    // alongside the scope filter rather than inside it — worth its own case.
    await expectNotFound(sessions().findOne("KMCP-BBB222", OFFICER));
  });

  it("can open one that is theirs", async () => {
    const session: any = await sessions().findOne("KMCP-AAA111", OFFICER);
    expect(session.id).toBe("ses_a");
  });

  it("does not filter an unscoped role", async () => {
    const page: any = await sessions().list(PAGE, ADMIN);
    expect(page.items.map((s: any) => s.id).sort()).toEqual(["ses_a", "ses_b"]);
  });
});

// ------------------------------------------------------------------- slots

describe("what a zone officer can see of the slots", () => {
  it("lists only bays in their zones", async () => {
    const page: any = await slots().list(PAGE, OFFICER);
    expect(page.items.map((s: any) => s.id)).toEqual(["slt_a"]);
    expect(page.total).toBe(1);
  });

  it("does not filter an unscoped role", async () => {
    const page: any = await slots().list(PAGE, ADMIN);
    expect(page.items.map((s: any) => s.id).sort()).toEqual(["slt_a", "slt_b"]);
  });
});

// ------------------------------------------------------- what is not enforced

/**
 * Five failures, four of them the same shape, all of them now closed.
 *
 * `list()` in these services built its `where` as one object literal with the
 * scope filter spread FIRST and the caller's query filters spread after it:
 *
 *     const where = {
 *       ...this.scopeFilter(user),          // { zoneId: { in: ["zn_a"] } }
 *       ...(query.zoneId ? { zoneId: query.zoneId } : {}),   // "zn_b"
 *     };
 *
 * Both wrote the same key, and in an object literal the last one wins. A zone
 * officer who appended `?zoneId=<any zone>` therefore replaced their own scope
 * rather than narrowing within it. Nothing threw; the rows simply arrived.
 *
 * The scope is now kept out of reach of the caller's filters: `scoped()` in
 * `src/common/rbac/scope.ts` takes the two as separate arguments and combines
 * them under `AND`, so a caller-supplied key intersects the scope instead of
 * replacing it — whatever key it happens to use. The fifth failure was the
 * fail-open default underneath all of them, and `zoneScopeOf()` in the same
 * file is what now distinguishes "unrestricted" from "nothing allocated yet".
 *
 * These were marked `.fails` while the bugs were live. They are ordinary tests
 * now, and they are the regression guard: each one goes red again the moment a
 * caller's filter is merged back into the same object as the scope.
 */
describe("filters a caller supplies narrow the scope, never replace it", () => {
  it("?zoneId= narrows the session scope rather than replacing it", async () => {
    const page: any = await sessions().list({ ...PAGE, zoneId: "zn_b" }, OFFICER);
    // An officer scoped to zn_a asking for zn_b gets nothing. Before the fix
    // they got Salt Lake's live sessions, plates and all.
    expect(page.items).toEqual([]);
  });

  it("still lets a scoped caller narrow to a zone they do hold", async () => {
    const page: any = await sessions().list({ ...PAGE, zoneId: "zn_a" }, OFFICER);
    // The filter has to keep working — intersecting, not just refusing.
    expect(page.items.map((s: any) => s.id)).toEqual(["ses_a"]);
  });

  it("?zoneId= narrows the slot scope rather than replacing it", async () => {
    const page: any = await slots().list({ ...PAGE, zoneId: "zn_b" }, OFFICER);
    expect(page.items).toEqual([]);
  });

  it("gives a zone officer with no zones assigned nothing, not everything", async () => {
    // `scopeFilter` used to read `!user.isZoneScoped || user.zoneIds.length === 0`
    // and return `{}` — no filter at all. An empty array means "unrestricted"
    // for an admin and "no zones assigned yet" for an officer, and the services
    // could not tell the two apart, so the officer with nothing assigned was
    // given everything. `JwtAuthGuard.resolveZoneScope` returns `[]` whenever
    // the `zoneScope:<userId>` config row is absent, and `UsersService` only
    // writes that row when the create call supplied a non-empty list — so this
    // was the state a zone officer was created in by default.
    //
    // The decision now keys off `isZoneScoped`, which distinguishes them.
    const unassigned = { ...OFFICER, zoneIds: [] };
    const page: any = await zones().list(PAGE, unassigned);
    expect(page.items).toEqual([]);
  });

  it("zones.findOne honours the id it was given, for a scoped caller", async () => {
    // The same collision read the other way round. `findOne` built
    // `{ id, ...this.scopeFilter(user) }`, with the scope spread LAST, so
    // `{ id: "zn_b" }` was replaced by `{ id: { in: ["zn_a"] } }` and the id the
    // caller asked for was discarded altogether.
    //
    // `GET /zones/zn_b` as an Alipore officer returned 200 with Alipore's row,
    // and so did `GET /zones/does-not-exist`. No data escaped the scope, but the
    // API confidently answered a question it was not asked, and the portal
    // rendered Alipore under Salt Lake's URL.
    await expectNotFound(zones().findOne("zn_b", OFFICER));
    await expectNotFound(zones().findOne("does-not-exist", OFFICER));
  });

  it("slot summary refuses a zone the officer does not hold", async () => {
    // `summary` built `{ zoneId, ...this.scopeFilter(user) }`, so the counts
    // were correctly clamped to zn_a — but `assertZone` was not scoped at all,
    // so the response carried zn_b's code, name and capacity. The officer
    // learned a zone exists and was handed their own numbers under its name.
    await expectNotFound(slots().summary("zn_b", OFFICER));
  });

  it("still summarises a zone the officer does hold", async () => {
    const summary: any = await slots().summary("zn_a", OFFICER);
    expect(summary.zone.id).toBe("zn_a");
    expect(summary.total).toBe(1);
  });
});
