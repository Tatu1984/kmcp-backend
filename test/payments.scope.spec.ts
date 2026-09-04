import { describe, expect, it } from "vitest";
import { PaymentMode, PaymentStatus } from "@prisma/client";

import { PaymentsService } from "../src/modules/payments/payments.service";
import { AppException } from "../src/common/errors/app.exception";
import type { AuthenticatedUser } from "../src/common/decorators/auth.decorators";

/**
 * Payment scope, tested as rows.
 *
 * `payments.service` has the same collision the session and slot lists had, one
 * level deeper: the scope for a vendor is `{ session: { vendorId } }` and for a
 * zone officer `{ session: { zoneId: { in } } }`, while `?vendorId=` writes
 * `{ session: { vendorId } }` too. One object literal, one key, last spread
 * wins — so the caller's vendor id did not narrow the scope, it replaced the
 * whole of it, including for a zone officer whose scope was about zones and had
 * nothing to do with vendors.
 *
 * Like the zone-scope spec, this applies the filter to real rows rather than
 * asserting on its shape: a service can build a correct filter and then have a
 * later spread quietly discard it.
 */

type Row = Record<string, any>;

/** Enough of Prisma's `where` grammar for the filters this service builds. */
function matches(row: Row, where: any): boolean {
  if (where === undefined || where === null) return true;
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return (cond as any[]).some((c) => matches(row, c));
    if (key === "AND") return (cond as any[]).every((c) => matches(row, c));

    const value = row[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return value === cond;
    if ("in" in cond) return (cond.in as any[]).includes(value);
    if ("contains" in cond) return String(value ?? "").includes(String(cond.contains));
    if ("gte" in cond || "lte" in cond) {
      const n = value instanceof Date ? value.getTime() : Number(value);
      if ("gte" in cond && !(n >= (cond.gte instanceof Date ? cond.gte.getTime() : cond.gte))) return false;
      if ("lte" in cond && !(n <= (cond.lte instanceof Date ? cond.lte.getTime() : cond.lte))) return false;
      return true;
    }
    return matches((value ?? {}) as Row, cond);
  });
}

/** Alipore, operated by vendor 1. */
const PAYMENT_A = {
  id: "pay_a",
  amount: 6490,
  refundedAmount: 0,
  mode: PaymentMode.CASH,
  status: PaymentStatus.CAPTURED,
  paidAt: new Date("2026-09-04T10:00:00.000Z"),
  session: { id: "ses_a", code: "KMCP-AAA111", zoneId: "zn_a", vendorId: "ven_1", plateNumber: "WB02AB1234" },
};

/** Salt Lake, operated by vendor 2. Neither the officer's zone nor their vendor. */
const PAYMENT_B = {
  ...PAYMENT_A,
  id: "pay_b",
  session: { id: "ses_b", code: "KMCP-BBB222", zoneId: "zn_b", vendorId: "ven_2", plateNumber: "WB02CD5678" },
};

function makeService() {
  const rows = [PAYMENT_A, PAYMENT_B];
  const found = (args: any = {}) => rows.filter((row) => matches(row, args.where));

  const prisma: any = {
    payment: {
      findMany: async (args: any = {}) => found(args),
      findFirst: async (args: any = {}) => found(args)[0] ?? null,
      count: async (args: any = {}) => found(args).length,
      groupBy: async (args: any) => {
        const counts = new Map<unknown, number>();
        for (const row of found(args)) {
          counts.set(row.mode, (counts.get(row.mode) ?? 0) + 1);
        }
        return [...counts].map(([mode, n]) => ({ mode, _sum: { amount: 6490 * n }, _count: { _all: n } }));
      },
      aggregate: async (args: any) => ({
        _sum: { amount: found(args).length * 6490, refundedAmount: 0 },
        _count: { _all: found(args).length },
      }),
    },
  };
  prisma.$transaction = async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg);

  const audit = { record: async () => undefined } as any;
  return new PaymentsService(prisma, audit, {} as any);
}

/** A zone officer for Alipore. Salt Lake is not theirs, and neither is any vendor. */
const OFFICER: AuthenticatedUser = {
  id: "usr_officer",
  role: "ZONE_OFFICER",
  isZoneScoped: true,
  name: "Zone Officer, Alipore",
  zoneIds: ["zn_a"],
  sessionId: "sess_1",
};

const VENDOR_1: AuthenticatedUser = {
  id: "usr_ven_1",
  role: "VENDOR",
  isZoneScoped: true,
  name: "Metro Parking",
  vendorId: "ven_1",
  zoneIds: ["zn_a"],
  sessionId: "sess_2",
};

const ADMIN: AuthenticatedUser = {
  id: "usr_admin",
  role: "ADMIN",
  isZoneScoped: false,
  name: "Administrator",
  zoneIds: [],
  sessionId: "sess_3",
};

const PAGE = { page: 1, pageSize: 20 } as any;

describe("what a zone officer can see of the payments", () => {
  it("lists only payments taken in their zones", async () => {
    const page: any = await makeService().list(PAGE, OFFICER);
    expect(page.items.map((p: any) => p.id)).toEqual(["pay_a"]);
    expect(page.total).toBe(1);
  });

  it("cannot reach another zone's takings with ?vendorId=", async () => {
    const page: any = await makeService().list({ ...PAGE, vendorId: "ven_2" }, OFFICER);

    // `?vendorId=` writes the same `session` key the zone scope uses. Merged
    // into one literal it replaced the scope outright, and an Alipore officer
    // asking after another operator was handed Salt Lake's takings.
    expect(page.items).toEqual([]);
  });

  it("cannot open a payment from another zone by id", async () => {
    await expect(makeService().findOne("pay_b", OFFICER)).rejects.toBeInstanceOf(AppException);
  });

  it("totals only what is theirs", async () => {
    const summary: any = await makeService().summary(OFFICER);
    expect(summary.count).toBe(1);
  });
});

describe("what a vendor can see of the payments", () => {
  it("lists only takings on their own sessions", async () => {
    const page: any = await makeService().list(PAGE, VENDOR_1);
    expect(page.items.map((p: any) => p.id)).toEqual(["pay_a"]);
  });

  it("cannot read another operator's takings by naming them", async () => {
    const page: any = await makeService().list({ ...PAGE, vendorId: "ven_2" }, VENDOR_1);

    // The commercial one: a vendor could read a competitor's daily takings on
    // the authority's own kerb by editing a query string.
    expect(page.items).toEqual([]);
  });

  it("can still narrow to its own vendor id", async () => {
    const page: any = await makeService().list({ ...PAGE, vendorId: "ven_1" }, VENDOR_1);
    expect(page.items.map((p: any) => p.id)).toEqual(["pay_a"]);
  });
});

describe("an unscoped role", () => {
  it("is not filtered", async () => {
    const page: any = await makeService().list(PAGE, ADMIN);
    expect(page.items.map((p: any) => p.id).sort()).toEqual(["pay_a", "pay_b"]);
  });

  it("can still filter by vendor when it asks to", async () => {
    const page: any = await makeService().list({ ...PAGE, vendorId: "ven_2" }, ADMIN);
    expect(page.items.map((p: any) => p.id)).toEqual(["pay_b"]);
  });
});
