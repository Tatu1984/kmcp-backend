import { describe, expect, it, vi } from "vitest";
import { PaymentMode, PaymentStatus, ReportFrequency, UserStatus } from "@prisma/client";

import { ReportsService } from "../src/modules/reports/reports.service";
import { ReportSchedulesService } from "../src/modules/reports/report-schedules.service";
import {
  describeRecurrence,
  nextRunAfter,
  periodFor,
  type RecurrenceRule,
} from "../src/modules/reports/recurrence";
import { AppException } from "../src/common/errors/app.exception";
import type { AuthenticatedUser } from "../src/common/decorators/auth.decorators";

/**
 * Scheduled reports.
 *
 * Four things in this subsystem can be wrong in a way nobody notices for weeks,
 * and they are what this file is about.
 *
 * **The clock.** Everything in the database is UTC and every screen renders
 * Asia/Kolkata, so a schedule that stored only an instant would honour "Monday
 * at eight" at half past one in the afternoon. The assertions below are written
 * as literal UTC instants rather than as round-trips through the same helper
 * that produced them, because a test that says `nextRunAfter(...)` equals
 * `nextRunAfter(...)` would pass just as happily against a UTC-naive
 * implementation.
 *
 * **The boundary.** A schedule due at exactly this instant must run and one due
 * a millisecond later must not, or a sweep either double-fires or drifts a tick
 * later every time.
 *
 * **The second delivery.** Vercel Cron can deliver twice and an operator can
 * curl the endpoint. Running a report twice is not harmless: it is two emails
 * and two rows in the history for one instruction.
 *
 * **The gate.** This is the one that matters. A schedule is the only path in
 * the platform that produces a report with no signed-in principal behind it, so
 * if it ran unscoped it would be a way for a ward officer to receive the
 * citizen register they are refused when they press the button. Every run is
 * therefore executed as the schedule's owner, and the assertions here drive the
 * *real* `ReportsService` rather than a stub, so the gate under test is the one
 * that will actually be in production.
 */

type Row = Record<string, any>;

/** Enough of Prisma's `where` grammar for the filters these services build. */
function matches(row: Row, where: any): boolean {
  if (where === undefined || where === null) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return (cond as any[]).some((c) => matches(row, c));
    if (key === "AND") return (cond as any[]).every((c) => matches(row, c));
    if (key === "NOT") return !matches(row, cond);

    const value = row[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) {
      return value instanceof Date && cond instanceof Date
        ? value.getTime() === cond.getTime()
        : value === cond;
    }
    if ("not" in cond) return value !== cond.not;
    if ("in" in cond) return (cond.in as any[]).includes(value);
    if ("isNot" in cond) return value != null;
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
    return matches((value ?? {}) as Row, cond);
  });
}

function sortRows(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const clauses: Row[] = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [field, direction] = Object.entries(clause)[0] as [string, string];
      const left = a[field] instanceof Date ? a[field].getTime() : a[field];
      const right = b[field] instanceof Date ? b[field].getTime() : b[field];
      if (left === right) continue;
      const order = left > right ? 1 : -1;
      return direction === "desc" ? -order : order;
    }
    return 0;
  });
}

/** A read-only table. */
function table(rows: Row[]) {
  const found = (args: any = {}) => sortRows(rows.filter((row) => matches(row, args.where)), args.orderBy);
  return {
    findMany: async (args: any = {}) => {
      const hits = found(args);
      return args.take ? hits.slice(0, args.take) : hits;
    },
    findFirst: async (args: any = {}) => found(args)[0] ?? null,
    findUnique: async (args: any = {}) => found(args)[0] ?? null,
    count: async (args: any = {}) => found(args).length,
    groupBy: async (args: any) => {
      const field = args.by[0];
      const counts = new Map<unknown, number>();
      for (const row of found(args)) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
      return [...counts].map(([key, n]) => ({ [field]: key, _count: { _all: n }, _sum: {} }));
    },
  };
}

/**
 * A writable table with the four operations the schedule runner needs.
 *
 * `updateMany` is the interesting one: it returns a count, and the count is
 * what the claim in `ReportSchedulesService` reads to decide whether it won.
 * A fake that ignored the `where` and always reported one would make the
 * double-invocation test pass against a broken claim.
 */
function writableTable(rows: Row[], prefix: string) {
  const read = table(rows);
  let seq = 0;
  // Reads hand back copies. In Postgres two concurrent sweeps hold two snapshots
  // of the row; in an array they would hold one object, and the second claim
  // would compare the value the first had just written against itself and win.
  const copy = (row: Row | null) => (row ? { ...row } : row);
  return {
    ...read,
    findMany: async (args: any = {}) => (await read.findMany(args)).map((r) => ({ ...r })),
    findFirst: async (args: any = {}) => copy(await read.findFirst(args)),
    findUnique: async (args: any = {}) => copy(await read.findUnique(args)),
    findUniqueOrThrow: async (args: any) => {
      const row = rows.find((r) => matches(r, args.where));
      if (!row) throw new Error("not found");
      return { ...row };
    },
    create: async (args: any) => {
      const row = { id: `${prefix}_${(seq += 1)}`, createdAt: new Date(), updatedAt: new Date(), ...args.data };
      rows.push(row);
      return row;
    },
    update: async (args: any) => {
      const row = rows.find((r) => matches(r, args.where));
      if (!row) throw new Error("not found");
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    },
    updateMany: async (args: any) => {
      const hits = rows.filter((r) => matches(r, args.where));
      for (const row of hits) Object.assign(row, args.data, { updatedAt: new Date() });
      return { count: hits.length };
    },
    delete: async (args: any) => {
      const index = rows.findIndex((r) => matches(r, args.where));
      if (index === -1) throw new Error("not found");
      return rows.splice(index, 1)[0];
    },
  };
}

// ------------------------------------------------------------------ the data

/** Friday 4 September 2026, 06:30 in Kolkata. 01:00 UTC. */
const NOW = new Date("2026-09-04T01:00:00.000Z");

const WITHIN = new Date("2026-08-15T10:00:00.000Z");

const OFFICER_USER = {
  id: "usr_officer",
  name: "Zone Officer, Alipore",
  role: "ZONE_OFFICER",
  email: "officer@kmc.gov.in",
  phone: "9830000010",
  status: UserStatus.ACTIVE,
  deletedAt: null,
  vendor: null,
  attendant: null,
  createdAt: WITHIN,
  lastLoginAt: WITHIN,
  _count: { vehicles: 0, passes: 0 },
};

const ADMIN_USER = {
  ...OFFICER_USER,
  id: "usr_admin",
  name: "Administrator",
  role: "ADMIN",
  email: "admin@kmc.gov.in",
};

const RETIRED_USER = {
  ...OFFICER_USER,
  id: "usr_retired",
  name: "Retired Officer",
  status: UserStatus.SUSPENDED,
};

/** Registered on 3 September in Kolkata — inside the window a daily run covers. */
const CITIZEN_A = {
  id: "usr_cit_1",
  name: "Ananya Bose",
  phone: "9830000001",
  email: "ananya@example.com",
  role: "CITIZEN",
  status: UserStatus.ACTIVE,
  deletedAt: null,
  vendor: null,
  attendant: null,
  createdAt: new Date("2026-09-03T06:00:00.000Z"),
  lastLoginAt: WITHIN,
  _count: { vehicles: 1, passes: 0 },
};

const CITIZEN_B = { ...CITIZEN_A, id: "usr_cit_2", name: "Rahul Sen", phone: "9830000002" };

/** In the officer's zone. Dated inside every window these schedules produce. */
const PAYMENT_A = {
  id: "pay_a",
  amount: 6490,
  refundedAmount: 0,
  mode: PaymentMode.CASH,
  status: PaymentStatus.CAPTURED,
  paidAt: new Date("2026-09-03T06:00:00.000Z"),
  receipt: { number: "RCP-A" },
  session: {
    code: "KMCP-AAA111",
    plateNumber: "WB02AB1234",
    zoneId: "zn_a",
    vendorId: "ven_1",
    zone: { name: "Alipore Road" },
    vendor: { orgName: "Metro Parking" },
  },
};

/** Salt Lake — not the officer's zone. */
const PAYMENT_B = {
  ...PAYMENT_A,
  id: "pay_b",
  session: {
    code: "KMCP-BBB222",
    plateNumber: "WB02CD5678",
    zoneId: "zn_b",
    vendorId: "ven_2",
    zone: { name: "Salt Lake Sector V" },
    vendor: { orgName: "Bengal Kerbside" },
  },
};

const OFFICER: AuthenticatedUser = {
  id: "usr_officer",
  role: "ZONE_OFFICER",
  isZoneScoped: true,
  name: "Zone Officer, Alipore",
  zoneIds: ["zn_a"],
  sessionId: "sess_1",
};

const ADMIN: AuthenticatedUser = {
  id: "usr_admin",
  role: "ADMIN",
  isZoneScoped: false,
  name: "Administrator",
  zoneIds: [],
  sessionId: "sess_2",
};

const PAGE = { page: 1, pageSize: 20 } as any;
const CTX = { ip: "203.0.113.5", requestId: "req_1" };

/** A daily 06:00 Kolkata schedule, due now unless told otherwise. */
function schedule(overrides: Row = {}): Row {
  return {
    id: `sch_${Math.random().toString(36).slice(2, 9)}`,
    name: "Daily collection",
    type: "revenue",
    params: { zoneId: null, vendorId: null, format: "csv" },
    frequency: ReportFrequency.DAILY,
    hour: 6,
    minute: 0,
    weekday: null,
    dayOfMonth: null,
    timezone: "Asia/Kolkata",
    channels: ["EMAIL"],
    ownerId: "usr_officer",
    isActive: true,
    nextRunAt: NOW,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastJobId: null,
    failureCount: 0,
    createdAt: WITHIN,
    updatedAt: WITHIN,
    ...overrides,
  };
}

function makeService(initial: Row[] = []) {
  const schedules: Row[] = initial.map((s) => ({ ...s }));
  const jobs: Row[] = [];
  const scheduleTable = writableTable(schedules, "sch_new");

  /**
   * Lets a test hold every concurrent sweep at the point where it has read the
   * due list but not yet claimed anything — which is exactly the interleaving a
   * duplicate cron delivery produces, and the only one where the claim is load
   * bearing.
   */
  let barrier: ((count: number) => Promise<void>) | null = null;
  const baseFindMany = scheduleTable.findMany;
  scheduleTable.findMany = async (args: any = {}) => {
    const rows = await baseFindMany(args);
    if (barrier) await barrier(rows.length);
    return rows;
  };

  const prisma: any = {
    reportSchedule: scheduleTable,
    reportJob: writableTable(jobs, "rpt"),
    user: table([OFFICER_USER, ADMIN_USER, RETIRED_USER, CITIZEN_A, CITIZEN_B]),
    payment: table([PAYMENT_A, PAYMENT_B]),
    auditLog: table([]),
    settlement: table([]),
    vehicle: table([]),
    parkingSession: table([]),
    vendor: table([{ id: "ven_1", orgName: "Metro Parking" }]),
    zone: table([{ id: "zn_a", name: "Alipore Road" }]),
    vendorZone: table([]),
    systemConfig: table([{ key: "zoneScope:usr_officer", value: ["zn_a"] }]),
  };
  prisma.$transaction = async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg);

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const messaging = { dispatch: vi.fn().mockResolvedValue({ requested: 1, sent: 1, failed: 0 }) };
  const notifications = { raise: vi.fn().mockResolvedValue(undefined) };
  const roles = {
    // The flag comes from the role row in production; these are the seeded values.
    isZoneScoped: async (code: string) => ["ZONE_OFFICER", "VENDOR", "ATTENDANT"].includes(code),
  };

  // The real report engine, deliberately. The gate under test has to be the one
  // that ships, not a stub that agrees with the test.
  const reports = new ReportsService(prisma, audit as any);

  const service = new ReportSchedulesService(
    prisma,
    reports,
    messaging as any,
    notifications as any,
    roles as any,
    audit as any,
  );

  return {
    service,
    schedules,
    jobs,
    messaging,
    notifications,
    audit,
    /** Blocks every sweep inside `findMany` until `n` of them have arrived. */
    holdSweeps(n: number) {
      let arrived = 0;
      let release!: () => void;
      const open = new Promise<void>((resolve) => (release = resolve));
      barrier = async () => {
        arrived += 1;
        if (arrived >= n) release();
        await open;
      };
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe(code));
}

const rule = (overrides: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  frequency: ReportFrequency.DAILY,
  hour: 6,
  minute: 0,
  weekday: null,
  dayOfMonth: null,
  timezone: "Asia/Kolkata",
  ...overrides,
});

// ------------------------------------------------------- the clock, in Kolkata

describe("what the authority meant by an hour", () => {
  it("fires a daily 06:00 schedule at 00:30 UTC, not at 06:00 UTC", () => {
    // The whole reason the timezone is a stored column. A UTC-naive runner puts
    // this at 2026-09-05T06:00:00Z — half past eleven in the morning — and the
    // officer who asked for the collection summary before their shift gets it
    // after lunch.
    expect(nextRunAfter(rule(), NOW).toISOString()).toBe("2026-09-05T00:30:00.000Z");
  });

  it("fires later the same day when the hour has not yet passed", () => {
    // NOW is 06:30 in Kolkata, so 07:00 is still ahead and 06:00 is not.
    expect(nextRunAfter(rule({ hour: 7 }), NOW).toISOString()).toBe("2026-09-04T01:30:00.000Z");
  });

  it("puts the Monday morning summary on Monday morning in Kolkata", () => {
    const monday = nextRunAfter(
      rule({ frequency: ReportFrequency.WEEKLY, weekday: 1, hour: 8 }),
      NOW,
    );
    // 08:00 IST on Monday 7 September. Five and a half hours before the 08:00Z
    // a UTC implementation would have chosen, and on the same calendar day —
    // which for a 00:30 schedule it would not have been.
    expect(monday.toISOString()).toBe("2026-09-07T02:30:00.000Z");
  });

  it("clamps a monthly day past the end of a short month instead of rolling over", () => {
    const february = nextRunAfter(
      rule({ frequency: ReportFrequency.MONTHLY, dayOfMonth: 31 }),
      new Date("2026-02-05T00:00:00.000Z"),
    );
    // The month-end statement lands on 28 February, not on 3 March.
    expect(february.toISOString()).toBe("2026-02-28T00:30:00.000Z");

    const september = nextRunAfter(rule({ frequency: ReportFrequency.MONTHLY, dayOfMonth: 31 }), NOW);
    expect(september.toISOString()).toBe("2026-09-30T00:30:00.000Z");
  });

  it("never returns the instant it was asked about", () => {
    // Called with the firing instant itself, which is what the runner does when
    // it advances a schedule it has just claimed. Returning the same instant
    // would make the schedule due again immediately and run it in a loop.
    const firesAt = nextRunAfter(rule(), NOW);
    expect(nextRunAfter(rule(), firesAt).toISOString()).toBe("2026-09-06T00:30:00.000Z");
  });

  it("skips the occurrences a paused or offline schedule missed", () => {
    // Three weeks of downtime does not mean twenty-one reports the moment the
    // platform comes back. The next run is the next real occurrence.
    const afterAnOutage = nextRunAfter(rule(), new Date("2026-09-25T01:00:00.000Z"));
    expect(afterAnOutage.toISOString()).toBe("2026-09-26T00:30:00.000Z");
  });

  it("describes itself in the same terms the officer chose", () => {
    expect(describeRecurrence(rule({ frequency: ReportFrequency.WEEKLY, weekday: 1, hour: 8 }))).toBe(
      "Every Monday at 08:00 (Asia/Kolkata)",
    );
  });
});

describe("the period a run reports on", () => {
  it("covers yesterday, as a local day", () => {
    // 06:00 IST on Friday 4 September. The window is Thursday, 00:00 to 24:00
    // Kolkata time — which is 18:30Z to 18:30Z, not midnight to midnight UTC.
    const period = periodFor(rule(), new Date("2026-09-04T00:30:00.000Z"));
    expect(period.from.toISOString()).toBe("2026-09-02T18:30:00.000Z");
    expect(period.to.toISOString()).toBe("2026-09-03T18:29:59.999Z");
  });

  it("covers the seven closed days behind a weekly run", () => {
    const period = periodFor(
      rule({ frequency: ReportFrequency.WEEKLY, weekday: 1, hour: 8 }),
      new Date("2026-09-07T02:30:00.000Z"),
    );
    expect(period.from.toISOString()).toBe("2026-08-30T18:30:00.000Z");
    expect(period.to.toISOString()).toBe("2026-09-06T18:29:59.999Z");
  });

  it("covers the previous calendar month, whole", () => {
    const period = periodFor(
      rule({ frequency: ReportFrequency.MONTHLY, dayOfMonth: 1 }),
      new Date("2026-09-01T00:30:00.000Z"),
    );
    // August entire, in local terms. "The last thirty days" would have
    // double-counted the overlap and reconciled with nothing.
    expect(period.from.toISOString()).toBe("2026-07-31T18:30:00.000Z");
    expect(period.to.toISOString()).toBe("2026-08-31T18:29:59.999Z");
  });

  it("never reaches into today", () => {
    // A window running up to the moment of the run would give two officers
    // comparing their copies of the same report two different totals.
    const period = periodFor(rule(), NOW);
    expect(period.to.getTime()).toBeLessThan(NOW.getTime());
  });
});

// ------------------------------------------------------------ due selection

describe("choosing what is due", () => {
  it("runs a schedule due at exactly this instant", async () => {
    const { service, jobs } = makeService([schedule({ nextRunAt: NOW })]);
    const summary = await service.runDue(NOW);
    expect(summary).toMatchObject({ due: 1, ran: 1, succeeded: 1 });
    expect(jobs).toHaveLength(1);
  });

  it("leaves one due a millisecond later alone", async () => {
    // The boundary is `lte`, and it has to be: a schedule that fires at 06:00
    // must be picked up by the sweep that runs at 06:00, not the one after.
    const { service, jobs } = makeService([
      schedule({ nextRunAt: new Date(NOW.getTime() + 1) }),
    ]);
    const summary = await service.runDue(NOW);
    expect(summary).toMatchObject({ due: 0, ran: 0 });
    expect(jobs).toHaveLength(0);
  });

  it("leaves a paused schedule alone however overdue it is", async () => {
    const { service, jobs } = makeService([
      schedule({ isActive: false, nextRunAt: new Date("2026-01-01T00:00:00.000Z") }),
    ]);
    expect(await service.runDue(NOW)).toMatchObject({ due: 0, ran: 0 });
    expect(jobs).toHaveLength(0);
  });

  it("takes only its allowance, oldest first", async () => {
    const older = schedule({ id: "sch_older", nextRunAt: new Date("2026-09-01T00:30:00.000Z") });
    const old = schedule({ id: "sch_old", nextRunAt: new Date("2026-09-02T00:30:00.000Z") });
    const recent = schedule({ id: "sch_recent", nextRunAt: new Date("2026-09-03T00:30:00.000Z") });
    const { service, schedules } = makeService([recent, older, old]);

    // A serverless function will not process a thousand schedules inside thirty
    // seconds, so the sweep is bounded — and a bounded sweep that did not take
    // the oldest first would starve whichever schedule sorted last, forever.
    const summary = await service.runDue(NOW, 2);
    expect(summary).toMatchObject({ due: 2, ran: 2 });

    const untouched = schedules.find((s) => s.id === "sch_recent")!;
    expect(untouched.lastRunAt).toBeNull();
    expect(schedules.find((s) => s.id === "sch_older")!.lastRunAt).toEqual(NOW);
  });

  it("advances the schedule past the window it just ran", async () => {
    const { service, schedules } = makeService([schedule({ nextRunAt: NOW })]);
    await service.runDue(NOW);
    expect(schedules[0].nextRunAt.toISOString()).toBe("2026-09-05T00:30:00.000Z");
  });
});

// --------------------------------------------------------- running it twice

describe("being invoked twice in the same window", () => {
  it("produces one report, not two, when the sweep is simply repeated", async () => {
    const { service, jobs, messaging } = makeService([schedule({ nextRunAt: NOW })]);

    await service.runDue(NOW);
    const second = await service.runDue(NOW);

    // The claim advanced `nextRunAt` past this instant, so the second sweep
    // finds nothing due at all — the same shape as the overstay sweep, whose
    // second call matches no still-ACTIVE sessions.
    expect(second).toMatchObject({ due: 0, ran: 0 });
    expect(jobs).toHaveLength(1);
    expect(messaging.dispatch).toHaveBeenCalledTimes(1);
  });

  it("produces one report when two sweeps read the same due list at once", async () => {
    const kit = makeService([schedule({ nextRunAt: NOW })]);
    // Both sweeps are held after reading and before claiming, which is the only
    // interleaving where the claim does any work — and precisely what two warm
    // instances receiving the same cron tick produce.
    kit.holdSweeps(2);

    const [a, b] = await Promise.all([kit.service.runDue(NOW), kit.service.runDue(NOW)]);

    expect(a.due + b.due).toBe(2);
    // Both saw it as due. Only one changed a row, and only that one ran it.
    expect(a.ran + b.ran).toBe(1);
    expect(kit.jobs).toHaveLength(1);
    expect(kit.messaging.dispatch).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------- the gate, on the
// scheduled path specifically

describe("a schedule cannot outrank the officer who set it", () => {
  it("refuses to create one for a report its owner may not run", async () => {
    const { service } = makeService();

    // The citizen register covers the whole authority and is refused to a
    // zone-scoped caller when they press the button. Being told at the moment
    // of creation is a courtesy — the run would refuse anyway, three days later,
    // having told nobody.
    await expectCode(
      service.create(
        { name: "Citizens", type: "user", frequency: ReportFrequency.DAILY, hour: 6, minute: 0, timezone: "Asia/Kolkata", format: "csv", channels: ["EMAIL"], isActive: true } as any,
        OFFICER,
        CTX,
      ),
      "FORBIDDEN",
    );
  });

  it("refuses to run one that already exists in the table", async () => {
    // The case that matters, because it is the one a create-time check cannot
    // cover: a role narrowed after the schedule was written, or a report moved
    // to an authority-wide audience. The gate has to be at the run, not only at
    // the door.
    const { service, jobs, messaging, schedules } = makeService([
      schedule({ type: "user", name: "Citizen register", ownerId: "usr_officer" }),
    ]);

    const summary = await service.runDue(NOW);

    expect(summary).toMatchObject({ ran: 1, succeeded: 0, failed: 1 });
    // Nothing was produced and nothing was sent. A refusal is not a report that
    // broke, so — exactly as on the interactive path — no ReportJob is left
    // behind for something that never began.
    expect(jobs).toHaveLength(0);
    expect(messaging.dispatch).not.toHaveBeenCalled();
    expect(schedules[0].lastStatus).toBe("FAILED");
    expect(schedules[0].lastError).toContain("whole authority");
  });

  it("runs the same schedule for an administrator", async () => {
    const { service, jobs, messaging } = makeService([
      schedule({ type: "user", name: "Citizen register", ownerId: "usr_admin" }),
    ]);

    expect(await service.runDue(NOW)).toMatchObject({ succeeded: 1, failed: 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].requestedById).toBe("usr_admin");
    expect(messaging.dispatch.mock.calls[0][0].payload.rowCount).toBe(2);
  });

  it("narrows a zonal report to the owner's zones, not the caller's", async () => {
    // The officer's schedule sees one payment; the administrator's sees both.
    // Neither run has a signed-in principal behind it — the scope comes from the
    // owner's row, rebuilt the way JwtAuthGuard rebuilds it from a token.
    const officers = makeService([schedule({ ownerId: "usr_officer" })]);
    await officers.service.runDue(NOW);
    expect(officers.messaging.dispatch.mock.calls[0][0].payload.rowCount).toBe(1);

    const admins = makeService([schedule({ ownerId: "usr_admin" })]);
    await admins.service.runDue(NOW);
    expect(admins.messaging.dispatch.mock.calls[0][0].payload.rowCount).toBe(2);
  });

  it("will not run for an account that is no longer active", async () => {
    // Revoking someone's access has to stop the reports that were running in
    // their name, or the revocation was cosmetic.
    const { service, jobs, schedules } = makeService([schedule({ ownerId: "usr_retired" })]);

    expect(await service.runDue(NOW)).toMatchObject({ succeeded: 0, failed: 1 });
    expect(jobs).toHaveLength(0);
    expect(schedules[0].lastError).toContain("no longer active");
  });

  it("refuses an edit that would point a schedule at a report its owner cannot run", async () => {
    // An administrator may edit a ward officer's schedule; changing the type to
    // one the officer cannot run would create something guaranteed to fail three
    // times and switch itself off.
    const { service, schedules } = makeService([schedule({ ownerId: "usr_officer" })]);
    await expectCode(service.update(schedules[0].id, { type: "audit" } as any, ADMIN, CTX), "FORBIDDEN");
  });

  it("runs a run-now as the owner, and does not move the next run", async () => {
    const { service, schedules, messaging } = makeService([
      schedule({ ownerId: "usr_officer", nextRunAt: new Date("2026-09-05T00:30:00.000Z") }),
    ]);

    // Pressed by an administrator, on somebody else's schedule. It produces the
    // owner's report, scoped to the owner's zone, delivered to the owner.
    await service.runNow(schedules[0].id, ADMIN, CTX);

    expect(messaging.dispatch.mock.calls[0][0].recipientUserId).toBe("usr_officer");
    expect(messaging.dispatch.mock.calls[0][0].payload.rowCount).toBe(1);
    expect(schedules[0].nextRunAt.toISOString()).toBe("2026-09-05T00:30:00.000Z");
  });
});

// ------------------------------------------------ failing, and giving up

describe("a schedule that keeps failing", () => {
  /** Three consecutive failures is the cap; the type is one its owner cannot run. */
  const doomed = () => schedule({ type: "user", name: "Citizen register", ownerId: "usr_officer" });

  it("counts failures rather than switching off on the first one", async () => {
    const { service, schedules, notifications } = makeService([doomed()]);

    await service.runDue(NOW);
    expect(schedules[0]).toMatchObject({ failureCount: 1, isActive: true });
    expect(notifications.raise).not.toHaveBeenCalled();
  });

  it("switches itself off at the cap and tells the owner why", async () => {
    const { service, schedules, notifications } = makeService([doomed()]);

    // Each sweep is a separate occurrence: the claim advances `nextRunAt`, so
    // the next one is a day later. Three days of failing is enough.
    await service.runDue(NOW);
    await service.runDue(new Date("2026-09-05T00:30:00.000Z"));
    const third = await service.runDue(new Date("2026-09-06T00:30:00.000Z"));

    expect(third).toMatchObject({ failed: 1, deactivated: 1 });
    expect(schedules[0]).toMatchObject({ failureCount: 3, isActive: false });

    // Silence would be the worst outcome: the officer stops receiving a report
    // and has no way of knowing the platform gave up rather than found nothing.
    expect(notifications.raise).toHaveBeenCalledTimes(1);
    const alert = notifications.raise.mock.calls[0][0];
    expect(alert.userId).toBe("usr_officer");
    expect(alert.payload.title).toContain("Citizen register");
    expect(alert.payload.body).toContain("failed 3 times");
  });

  it("stops being swept once it is off", async () => {
    const { service, schedules } = makeService([doomed()]);
    await service.runDue(NOW);
    await service.runDue(new Date("2026-09-05T00:30:00.000Z"));
    await service.runDue(new Date("2026-09-06T00:30:00.000Z"));

    // The point of deactivating rather than retrying: the platform stops doing
    // work it already knows will fail.
    expect(await service.runDue(new Date("2026-09-07T00:30:00.000Z"))).toMatchObject({ due: 0 });
    expect(schedules[0].failureCount).toBe(3);
  });

  it("forgets the count after a success", async () => {
    // The cap counts *consecutive* failures, so an intermittent outage never
    // accumulates towards a pause.
    const { service, schedules } = makeService([schedule({ failureCount: 2 })]);
    await service.runDue(NOW);
    expect(schedules[0]).toMatchObject({ failureCount: 0, isActive: true, lastStatus: "COMPLETED" });
  });

  it("starts the count again when a paused schedule is resumed", async () => {
    const { service, schedules } = makeService([
      schedule({ isActive: false, failureCount: 3, type: "revenue" }),
    ]);

    await service.update(schedules[0].id, { isActive: true } as any, OFFICER, CTX);

    // Otherwise a single further failure would switch off something an officer
    // had just deliberately turned back on.
    expect(schedules[0]).toMatchObject({ isActive: true, failureCount: 0 });
  });
});

// ------------------------------------------------------------------- scope

describe("whose schedules a caller may see and manage", () => {
  const both = () => [
    schedule({ id: "sch_officer", ownerId: "usr_officer", name: "Officer's daily" }),
    schedule({ id: "sch_admin", ownerId: "usr_admin", name: "Head office weekly" }),
  ];

  it("shows a zone officer only their own", async () => {
    const { service } = makeService(both());
    const page: any = await service.list(PAGE, OFFICER);
    // The row names the owner, the report, the zone and the hour — a
    // description of what head office is watching, and the ids to try against
    // the run-now route.
    expect(page.items.map((s: any) => s.id)).toEqual(["sch_officer"]);
    expect(page.total).toBe(1);
  });

  it("shows an administrator every schedule in the authority", async () => {
    const { service } = makeService(both());
    const page: any = await service.list(PAGE, ADMIN);
    expect(page.total).toBe(2);
  });

  it("answers not-found rather than forbidden for one outside the scope", async () => {
    // A caller outside the scope should not learn that the id exists.
    const { service } = makeService(both());
    await expectCode(service.findOne("sch_admin", OFFICER), "NOT_FOUND");
    await expectCode(service.remove("sch_admin", OFFICER, CTX), "NOT_FOUND");
    await expectCode(service.runNow("sch_admin", OFFICER, CTX), "NOT_FOUND");
  });

  it("owns a new schedule to its creator, whatever the body said", async () => {
    const { service, schedules } = makeService();
    await service.create(
      {
        name: "My revenue",
        type: "revenue",
        frequency: ReportFrequency.WEEKLY,
        weekday: 1,
        hour: 8,
        minute: 0,
        timezone: "Asia/Kolkata",
        format: "csv",
        channels: ["EMAIL"],
        isActive: true,
        // Not a field the schema accepts; here to show it changes nothing.
        ownerId: "usr_admin",
      } as any,
      OFFICER,
      CTX,
    );

    expect(schedules[0].ownerId).toBe("usr_officer");
    expect(schedules[0].nextRunAt.toISOString()).toBe("2026-09-07T02:30:00.000Z");
  });

  it("refuses a recurrence that could never fire", async () => {
    const { service } = makeService();
    await expectCode(
      service.create(
        { name: "Weekly", type: "revenue", frequency: ReportFrequency.WEEKLY, hour: 8, minute: 0, timezone: "Asia/Kolkata", format: "csv", channels: ["EMAIL"], isActive: true } as any,
        OFFICER,
        CTX,
      ),
      "VALIDATION_FAILED",
    );

    await expectCode(
      service.create(
        { name: "Daily", type: "revenue", frequency: ReportFrequency.DAILY, hour: 8, minute: 0, timezone: "Mars/Olympus", format: "csv", channels: ["EMAIL"], isActive: true } as any,
        OFFICER,
        CTX,
      ),
      "VALIDATION_FAILED",
    );
  });

  it("recomputes the next run when the hour is edited", async () => {
    const { service, schedules } = makeService([schedule({ hour: 6 })]);
    // Leaving yesterday's instant in place would run the schedule at the old
    // hour once more before the change took effect.
    await service.update(schedules[0].id, { hour: 22 } as any, OFFICER, CTX);
    expect(schedules[0].nextRunAt.toISOString()).toBe("2026-09-04T16:30:00.000Z");
  });
});

// ------------------------------------------------------------ the delivery

describe("telling the owner", () => {
  it("reuses report.ready rather than inventing a second template", async () => {
    const { service, messaging } = makeService([schedule({ channels: ["EMAIL"] })]);
    await service.runDue(NOW);

    const call = messaging.dispatch.mock.calls[0][0];
    // An officer must not be able to tell whether the report they were sent came
    // from the button or from the schedule, because there is no difference.
    expect(call.template).toBe("report.ready");
    expect(call.channels).toEqual(["EMAIL"]);
    expect(call.payload.rangeLabel).toBe("03 Sep – 03 Sep 2026");
  });

  it("raises the portal bell as well as the outbound channels", async () => {
    const { service, notifications } = makeService([schedule()]);
    await service.runDue(NOW);
    expect(notifications.raise.mock.calls[0][0]).toMatchObject({
      userId: "usr_officer",
      template: "report.ready",
    });
  });

  it("records the run as a ReportJob the history screen already shows", async () => {
    const { service, jobs, schedules } = makeService([schedule()]);
    await service.runDue(NOW);

    // Not a parallel history. The same table, the same requester column, the
    // same download route — a scheduled run is simply a run somebody asked for
    // in advance.
    expect(jobs[0]).toMatchObject({ type: "revenue", requestedById: "usr_officer", status: "COMPLETED" });
    expect(schedules[0].lastJobId).toBe(jobs[0].id);
  });
});
