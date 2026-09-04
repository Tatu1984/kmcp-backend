import { describe, expect, it } from "vitest";
import { PaymentMode, PaymentStatus, ReportStatus, UserStatus } from "@prisma/client";

import { ReportsService } from "../src/modules/reports/reports.service";
import { AppException } from "../src/common/errors/app.exception";
import type { AuthenticatedUser } from "../src/common/decorators/auth.decorators";

/**
 * Reports, tested as rows and as refusals.
 *
 * Three of the eleven builders read rows that carry no zone — the citizen
 * register, the audit trail and vendor settlement — and two of the three took
 * no principal at all. A zone officer holds `report.generate` (it is in the
 * seeded grant, `20260807120000_roles_into_the_database`), so the whole of each
 * of those was one POST away from a ward officer, and one guessed job id away
 * through the download route.
 *
 * The fix is a refusal rather than a narrowing, so most of what is asserted
 * here is that nothing comes back at all: "the citizens who parked in my ward"
 * is a different report from "the citizen register", and quietly serving the
 * first under the second's heading is a leak of a different kind — the reader
 * cannot tell that anything is missing. The zonal reports are asserted the
 * other way, on which rows survive, because those genuinely do narrow.
 */

type Row = Record<string, any>;

/** Enough of Prisma's `where` grammar for the filters this service builds. */
function matches(row: Row, where: any): boolean {
  if (where === undefined || where === null) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return (cond as any[]).some((c) => matches(row, c));
    if (key === "AND") return (cond as any[]).every((c) => matches(row, c));
    if (key === "NOT") return !matches(row, cond);

    const value = row[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return value === cond;
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
      return [...counts].map(([key, n]) => ({ [field]: key, _count: { _all: n }, _sum: {} }));
    },
  };
}

// ------------------------------------------------------------------ the data

const PERIOD = { from: new Date("2026-08-01T00:00:00.000Z"), to: new Date("2026-08-31T23:59:59.000Z") };
const WITHIN = new Date("2026-08-15T10:00:00.000Z");

const CITIZEN_A = {
  id: "usr_cit_1",
  name: "Ananya Bose",
  phone: "9830000001",
  email: "ananya@example.com",
  role: "CITIZEN",
  status: UserStatus.ACTIVE,
  deletedAt: null,
  createdAt: WITHIN,
  lastLoginAt: WITHIN,
  _count: { vehicles: 1, passes: 0 },
};

const CITIZEN_B = {
  ...CITIZEN_A,
  id: "usr_cit_2",
  name: "Rahul Sen",
  phone: "9830000002",
  email: "rahul@example.com",
};

const OFFICER_USER = {
  id: "usr_officer",
  name: "Zone Officer, Alipore",
  role: "ZONE_OFFICER",
  deletedAt: null,
  createdAt: WITHIN,
  lastLoginAt: WITHIN,
  _count: { vehicles: 0, passes: 0 },
};

const ADMIN_USER = { ...OFFICER_USER, id: "usr_admin", name: "Administrator", role: "ADMIN" };

const AUDIT_A = {
  id: "aud_1",
  actorUserId: "usr_admin",
  action: "TARIFF_PUBLISH",
  entity: "Tariff",
  entityId: "trf_1",
  before: null,
  after: null,
  ip: "203.0.113.1",
  createdAt: WITHIN,
};

const SETTLEMENT_1 = {
  id: "stl_1",
  vendorId: "ven_1",
  periodStart: new Date("2026-08-01T00:00:00.000Z"),
  periodEnd: new Date("2026-08-15T00:00:00.000Z"),
  grossCollected: 100000,
  cashCollected: 60000,
  digitalCollected: 40000,
  commissionAmount: 10000,
  vendorShare: 10000,
  governmentShare: 90000,
  status: "PENDING_APPROVAL",
  payoutRef: null,
  vendor: { orgName: "Metro Parking" },
  _count: { lines: 12 },
};

const SETTLEMENT_2 = {
  ...SETTLEMENT_1,
  id: "stl_2",
  vendorId: "ven_2",
  vendor: { orgName: "Bengal Kerbside" },
};

/** Alipore, vendor 1. */
const PAYMENT_A = {
  id: "pay_a",
  amount: 6490,
  refundedAmount: 0,
  mode: PaymentMode.CASH,
  status: PaymentStatus.CAPTURED,
  paidAt: WITHIN,
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

/** Salt Lake, vendor 2 — neither the officer's zone nor their vendor. */
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

/** An administrator's citizen export. The officer must not reach it. */
const JOB_ADMIN_CITIZENS = {
  id: "rpt_admin_citizens",
  type: "user",
  params: { from: PERIOD.from.toISOString(), to: PERIOD.to.toISOString(), format: "csv" },
  status: ReportStatus.COMPLETED,
  requestedById: "usr_admin",
  error: null,
  createdAt: WITHIN,
  completedAt: WITHIN,
};

/** The officer's own revenue export, which they may still have. */
const JOB_OFFICER_REVENUE = {
  ...JOB_ADMIN_CITIZENS,
  id: "rpt_officer_revenue",
  type: "revenue",
  requestedById: "usr_officer",
};

/**
 * A citizen export the officer themselves ran, back when they could.
 *
 * Rows like this are why the gate lives in `build` rather than only in
 * `generate`: the job is theirs, so job visibility lets them ask for it, and
 * the only thing standing between them and the register is the builder saying no.
 */
const JOB_OFFICER_CITIZENS = {
  ...JOB_ADMIN_CITIZENS,
  id: "rpt_officer_citizens",
  requestedById: "usr_officer",
};

function makeService() {
  const jobs: Row[] = [JOB_ADMIN_CITIZENS, JOB_OFFICER_REVENUE, JOB_OFFICER_CITIZENS].map((j) => ({
    ...j,
  }));
  const jobTable = table(jobs);
  let seq = 0;

  const prisma: any = {
    reportJob: {
      ...jobTable,
      create: async (args: any) => {
        const row = { id: `rpt_new_${(seq += 1)}`, createdAt: new Date(), completedAt: null, error: null, ...args.data };
        jobs.push(row);
        return row;
      },
      update: async (args: any) => {
        const row = jobs.find((j) => j.id === args.where.id);
        Object.assign(row as Row, args.data);
        return row;
      },
    },
    user: table([CITIZEN_A, CITIZEN_B, OFFICER_USER, ADMIN_USER]),
    auditLog: table([AUDIT_A]),
    settlement: table([SETTLEMENT_1, SETTLEMENT_2]),
    payment: table([PAYMENT_A, PAYMENT_B]),
    vehicle: table([{ id: "veh_1", ownerUserId: "usr_cit_1" }]),
    parkingSession: table([]),
    vendor: table([]),
    zone: table([]),
  };
  prisma.$transaction = async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg);

  return new ReportsService(prisma, { record: async () => undefined } as any);
}

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

const VENDOR_1: AuthenticatedUser = {
  id: "usr_ven_1",
  role: "VENDOR",
  isZoneScoped: true,
  name: "Metro Parking",
  vendorId: "ven_1",
  zoneIds: ["zn_a"],
  sessionId: "sess_3",
};

const PAGE = { page: 1, pageSize: 20 } as any;
const CTX = { ip: "203.0.113.5", requestId: "req_1" };

const run = (type: string, user: AuthenticatedUser) =>
  makeService().generate({ ...PERIOD, type, format: "csv" } as any, user, CTX);

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe(code));
}

// ------------------------------------------------- the three authority reports

describe("reports that cover the whole authority", () => {
  it("refuses the citizen register to a zone officer", async () => {
    // `citizens()` took no principal at all. A ward officer holding
    // `report.generate` could export every citizen in the authority, mobile
    // number and email included, in one request.
    await expectCode(run("user", OFFICER), "FORBIDDEN");
  });

  it("refuses the audit trail to a zone officer", async () => {
    // The same shape, and worse in kind: an audit trail is trusted because it
    // is whole, so a filtered copy would have been more dangerous than a
    // refusal — nobody reading it could tell what had been left out.
    await expectCode(run("audit", OFFICER), "FORBIDDEN");
  });

  it("refuses vendor settlement to a zone officer", async () => {
    // A Settlement carries no zone: one row is a vendor's whole period across
    // every kerb they hold. There is no ward-sized version to hand back, so the
    // report was authority-wide in fact while being offered to a ward.
    await expectCode(run("settlement", OFFICER), "FORBIDDEN");
  });

  it("does not record the refusal as a failed report", async () => {
    // The gate runs before the job row is written. A refusal is not a report
    // that broke, and leaving a FAILED row behind would put something in the
    // history that never began.
    const service = makeService();
    await service.generate({ ...PERIOD, type: "user", format: "csv" } as any, OFFICER, CTX).catch(() => null);
    const page: any = await service.list(PAGE, OFFICER);
    expect(page.items.map((j: any) => j.id).sort()).toEqual([
      "rpt_officer_citizens",
      "rpt_officer_revenue",
    ]);
  });

  it("runs all three for an administrator, with the rows in them", async () => {
    const citizens: any = await run("user", ADMIN);
    expect(citizens.rowCount).toBe(2);

    const audit: any = await run("audit", ADMIN);
    expect(audit.rowCount).toBe(1);

    const settlement: any = await run("settlement", ADMIN);
    expect(settlement.rowCount).toBe(2);
  });

  it("still lets a vendor pull their own settlement, and only their own", async () => {
    // The one exception. It is the vendor's own money and the report was
    // already filtered to their id; refusing it would take away a statement
    // they are entitled to.
    const service = makeService();
    const job: any = await service.generate(
      { ...PERIOD, type: "settlement", format: "csv" } as any,
      VENDOR_1,
      CTX,
    );
    expect(job.rowCount).toBe(1);

    const file = await service.download(job.id, VENDOR_1);
    expect(file.csv).toContain("Metro Parking");
    expect(file.csv).not.toContain("Bengal Kerbside");
  });

  it("refuses the citizen register to a vendor too", async () => {
    await expectCode(run("user", VENDOR_1), "FORBIDDEN");
  });
});

// ----------------------------------------------------------- what still works

describe("the zonal reports a zone officer may still run", () => {
  it("runs revenue, narrowed to their own zones", async () => {
    const service = makeService();
    const job: any = await service.generate(
      { ...PERIOD, type: "revenue", format: "csv" } as any,
      OFFICER,
      CTX,
    );
    expect(job.rowCount).toBe(1);

    const file = await service.download(job.id, OFFICER);
    expect(file.csv).toContain("WB02AB1234");
    expect(file.csv).not.toContain("WB02CD5678");
  });

  it("does not narrow the same report for an administrator", async () => {
    const job: any = await run("revenue", ADMIN);
    expect(job.rowCount).toBe(2);
  });
});

// --------------------------------------------------------------- the catalogue

describe("the catalogue the portal builds its grid from", () => {
  it("withholds the three a zone officer cannot run", async () => {
    const keys = makeService()
      .catalogue(OFFICER)
      .map((t) => t.key);
    // Otherwise the officer's reports screen shows three tiles that answer 403
    // when pressed, which reads as a broken portal rather than a held boundary.
    expect(keys).not.toContain("user");
    expect(keys).not.toContain("audit");
    expect(keys).not.toContain("settlement");
    expect(keys).toContain("revenue");
    expect(keys).toContain("occupancy");
  });

  it("offers an administrator everything", async () => {
    expect(makeService().catalogue(ADMIN)).toHaveLength(11);
  });

  it("offers a vendor their settlement but not the registers", async () => {
    const keys = makeService()
      .catalogue(VENDOR_1)
      .map((t) => t.key);
    expect(keys).toContain("settlement");
    expect(keys).not.toContain("user");
    expect(keys).not.toContain("audit");
  });

  it("offers exactly what it will run", async () => {
    // The grid and the gate read the same field, and this is what pins them
    // together: anything the catalogue offers must actually execute.
    const service = makeService();
    for (const type of service.catalogue(OFFICER).map((t) => t.key)) {
      await expect(
        service.generate({ ...PERIOD, type, format: "csv" } as any, OFFICER, CTX),
      ).resolves.toBeTruthy();
    }
  });
});

// ------------------------------------------------------------- the job history

describe("the job history", () => {
  it("shows a zone officer only the reports they ran themselves", async () => {
    const page: any = await makeService().list(PAGE, OFFICER);
    // The row carries the requester's name and the parameters they chose, so an
    // unfiltered history told a ward officer which zones, vendors and periods
    // head office was pulling apart — and handed them the ids to try against
    // the download route.
    expect(page.items.map((j: any) => j.id).sort()).toEqual([
      "rpt_officer_citizens",
      "rpt_officer_revenue",
    ]);
    expect(page.total).toBe(2);
  });

  it("shows an administrator every job", async () => {
    const page: any = await makeService().list(PAGE, ADMIN);
    expect(page.total).toBe(3);
  });

  it("lets ?mine= narrow an administrator's history without widening an officer's", async () => {
    const mine: any = await makeService().list({ ...PAGE, mine: true }, ADMIN);
    expect(mine.items.map((j: any) => j.id)).toEqual(["rpt_admin_citizens"]);

    const theirs: any = await makeService().list({ ...PAGE, mine: true }, OFFICER);
    expect(theirs.total).toBe(2);
  });
});

// ------------------------------------------------------------ the download path

describe("the download route", () => {
  it("will not hand an officer an administrator's job by id", async () => {
    // The half that was safe: `download` re-runs under the caller's own
    // principal, so a zonal report obeyed the caller's zones rather than the
    // requester's. The half that was not: the three builders that took no
    // principal, which this id points at.
    await expectCode(makeService().download("rpt_admin_citizens", OFFICER), "NOT_FOUND");
  });

  it("refuses even a job of their own that they may no longer run", async () => {
    // Job visibility lets them ask for this one — it is theirs. `build` is what
    // says no, which is why the gate lives at the choke point and not only at
    // the entrance `generate` uses.
    await expectCode(makeService().download("rpt_officer_citizens", OFFICER), "FORBIDDEN");
  });

  it("still serves the administrator the same job", async () => {
    const file = await makeService().download("rpt_admin_citizens", ADMIN);
    expect(file.csv).toContain("Ananya Bose");
    expect(file.filename).toBe("user-2026-08-01-to-2026-08-31.csv");
  });
});
