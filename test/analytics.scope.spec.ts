import { describe, expect, it } from "vitest";
import {
  IncidentStatus,
  IncidentType,
  PassStatus,
  PaymentMode,
  PaymentStatus,
  SessionStatus,
  SettlementStatus,
  ShiftStatus,
  UserStatus,
  VendorStatus,
  ZoneStatus,
} from "@prisma/client";

import { AnalyticsService } from "../src/modules/analytics/analytics.service";
import type { AuthenticatedUser } from "../src/common/decorators/auth.decorators";

/**
 * The dashboard, tested as rows.
 *
 * `overview()` was half scoped, which is the hardest kind of wrong to notice: a
 * ward officer's screen was mostly their own ward, so the four numbers that
 * were not looked exactly as local as the ones that were. Incidents, shifts and
 * the live feed all read models that carry a `zoneId` and whose own services
 * already filter on it.
 *
 * The other half of this spec is the split itself. Vendors, citizens, passes
 * and settlements are authority-wide on purpose — none of those rows belongs to
 * a ward — and the portal now labels them so. The cases at the bottom pin that
 * decision down, because a figure that quietly changes from authority-wide to
 * scoped leaves the label behind and the dashboard starts lying about which of
 * the two the reader is looking at.
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
  const sum = (list: Row[], fields: object | undefined) =>
    Object.fromEntries(
      Object.keys(fields ?? {}).map((f) => [f, list.reduce((s, r) => s + (r[f] ?? 0), 0)]),
    );
  return {
    findMany: async (args: any = {}) => found(args),
    findFirst: async (args: any = {}) => found(args)[0] ?? null,
    count: async (args: any = {}) => found(args).length,
    aggregate: async (args: any = {}) => {
      const hit = found(args);
      return { _sum: sum(hit, args._sum), _count: { _all: hit.length } };
    },
    groupBy: async (args: any) => {
      const field = args.by[0];
      const groups = new Map<unknown, Row[]>();
      for (const row of found(args)) groups.set(row[field], [...(groups.get(row[field]) ?? []), row]);
      return [...groups].map(([key, list]) => ({
        [field]: key,
        _count: { _all: list.length },
        _sum: sum(list, args._sum),
      }));
    },
  };
}

// ---------------------------------------------------------------- the kerb

const NOW = new Date();

const ZONE_A = { id: "zn_a", capacity: 10, status: ZoneStatus.OPEN };
const ZONE_B = { id: "zn_b", capacity: 12, status: ZoneStatus.OPEN };

const SESSION_A = {
  id: "ses_a",
  code: "KMCP-AAA111",
  zoneId: "zn_a",
  vendorId: "ven_1",
  plateNumber: "WB02AB1234",
  status: SessionStatus.ACTIVE,
  startAt: NOW,
  endAt: null,
  payableAmount: 6490,
  zone: { name: "Alipore Road" },
};

const SESSION_B = {
  ...SESSION_A,
  id: "ses_b",
  code: "KMCP-BBB222",
  zoneId: "zn_b",
  vendorId: "ven_2",
  plateNumber: "WB02CD5678",
  zone: { name: "Salt Lake Sector V" },
};

const PAYMENT_A = {
  id: "pay_a",
  amount: 6490,
  refundedAmount: 0,
  mode: PaymentMode.CASH,
  status: PaymentStatus.CAPTURED,
  paidAt: NOW,
  session: { code: "KMCP-AAA111", zoneId: "zn_a", vendorId: "ven_1", plateNumber: "WB02AB1234", zone: { name: "Alipore Road" } },
};

const PAYMENT_B = {
  ...PAYMENT_A,
  id: "pay_b",
  session: { code: "KMCP-BBB222", zoneId: "zn_b", vendorId: "ven_2", plateNumber: "WB02CD5678", zone: { name: "Salt Lake Sector V" } },
};

/** Raised against the officer's own zone. */
const INCIDENT_A = {
  id: "inc_a",
  type: IncidentType.ILLEGAL_PARKING,
  description: "Blocking the ramp on Alipore Road",
  status: IncidentStatus.OPEN,
  zoneId: "zn_a",
  session: null,
  createdAt: NOW,
};

/** Salt Lake. Not theirs. */
const INCIDENT_B = {
  ...INCIDENT_A,
  id: "inc_b",
  description: "Damage to a bollard in Sector V",
  zoneId: "zn_b",
};

/**
 * No zone of its own, raised against a session in Alipore.
 *
 * This is why the scope is an `OR` over both routes rather than a filter on
 * `zoneId`: an incident a citizen raises from the app carries the session, not
 * the zone, and filtering on the column alone would have dropped it.
 */
const INCIDENT_C = {
  ...INCIDENT_A,
  id: "inc_c",
  description: "Disputed fare on a session in Alipore",
  status: IncidentStatus.IN_PROGRESS,
  zoneId: null,
  session: { zoneId: "zn_a", vendorId: "ven_1" },
};

const SHIFT_A = {
  id: "shf_a",
  zoneId: "zn_a",
  vendorId: "ven_1",
  attendantId: "att_a",
  status: ShiftStatus.OPEN,
  startAt: NOW,
  endAt: null,
  attendant: { user: { name: "Suman Das" } },
  zone: { name: "Alipore Road" },
};

const SHIFT_B = {
  ...SHIFT_A,
  id: "shf_b",
  zoneId: "zn_b",
  vendorId: "ven_2",
  attendantId: "att_b",
  status: ShiftStatus.VARIANCE_FLAGGED,
  endAt: NOW,
  attendant: { user: { name: "Prakash Roy" } },
  zone: { name: "Salt Lake Sector V" },
};

const SHIFT_C = { ...SHIFT_A, id: "shf_c", zoneId: "zn_b", status: ShiftStatus.CLOSED, endAt: NOW };

const ATTENDANT_A = { id: "att_a", vendorId: "ven_1", defaultZoneId: "zn_a", isActive: true };
const ATTENDANT_B = { id: "att_b", vendorId: "ven_2", defaultZoneId: "zn_b", isActive: true };

const SETTLEMENTS = [
  { id: "stl_1", vendorId: "ven_1", status: SettlementStatus.PENDING_APPROVAL, vendorShare: 0 },
  { id: "stl_2", vendorId: "ven_2", status: SettlementStatus.PENDING_APPROVAL, vendorShare: 0 },
  { id: "stl_3", vendorId: "ven_2", status: SettlementStatus.APPROVED, vendorShare: 45000 },
];

const VENDORS = [
  { id: "ven_1", status: VendorStatus.APPROVED },
  { id: "ven_2", status: VendorStatus.APPROVED },
  { id: "ven_3", status: VendorStatus.PENDING },
];

const CITIZENS = [
  { id: "usr_cit_1", role: "CITIZEN", status: UserStatus.ACTIVE, deletedAt: null },
  { id: "usr_cit_2", role: "CITIZEN", status: UserStatus.ACTIVE, deletedAt: null },
];

const PASSES = [
  { id: "pss_1", status: PassStatus.ACTIVE, validTo: new Date(NOW.getTime() + 86_400_000) },
  { id: "pss_2", status: PassStatus.ACTIVE, validTo: new Date(NOW.getTime() + 86_400_000) },
];

function service() {
  const prisma: any = {
    zone: table([ZONE_A, ZONE_B]),
    parkingSession: table([SESSION_A, SESSION_B]),
    payment: table([PAYMENT_A, PAYMENT_B]),
    incident: table([INCIDENT_A, INCIDENT_B, INCIDENT_C]),
    shift: table([SHIFT_A, SHIFT_B, SHIFT_C]),
    attendant: table([ATTENDANT_A, ATTENDANT_B]),
    settlement: table(SETTLEMENTS),
    vendor: table(VENDORS),
    user: table(CITIZENS),
    pass: table(PASSES),
    vendorZone: table([{ vendorId: "ven_1", zoneId: "zn_a" }, { vendorId: "ven_2", zoneId: "zn_b" }]),
  };
  return new AnalyticsService(prisma);
}

/** A zone officer for Alipore. Salt Lake is not theirs. */
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

// ------------------------------------------------------- what is now scoped

describe("the figures a zone officer's dashboard narrows", () => {
  it("counts only open incidents in their own zones", async () => {
    const overview: any = await service().overview(OFFICER);
    // Two of the three: the one on their zone and the one on a session in it.
    // Salt Lake's is not theirs, and used to be counted anyway.
    expect(overview.openIncidents).toBe(2);
  });

  it("counts every open incident for an administrator", async () => {
    const overview: any = await service().overview(ADMIN);
    expect(overview.openIncidents).toBe(3);
  });

  it("counts only shifts worked in their own zones", async () => {
    const overview: any = await service().overview(OFFICER);
    expect(overview.openShifts).toBe(1);
    expect(overview.attendantsOnShift).toBe(1);
    // The two that matter operationally. A variance is a cash difference
    // somebody has to explain, and an officer chasing another ward's is
    // chasing a deposit that was never theirs to reconcile.
    expect(overview.varianceShifts).toBe(0);
    expect(overview.awaitingVerification).toBe(0);
  });

  it("counts every shift for an administrator", async () => {
    const overview: any = await service().overview(ADMIN);
    expect(overview.openShifts).toBe(1);
    expect(overview.varianceShifts).toBe(1);
    expect(overview.awaitingVerification).toBe(1);
  });

  it("counts only attendants posted to their zones", async () => {
    const officer: any = await service().overview(OFFICER);
    const admin: any = await service().overview(ADMIN);
    expect(officer.totalAttendants).toBe(1);
    expect(admin.totalAttendants).toBe(2);
  });

  it("keeps another ward's events out of the live feed", async () => {
    const feed: any[] = await service().feed(OFFICER);
    const ids = feed.map((item) => item.id);

    // The session and payment halves were scoped from the start, which made the
    // feed look local — so another ward's incident arriving in it read as
    // something happening on the officer's own kerb.
    expect(ids).toContain("inc_inc_a");
    expect(ids).toContain("inc_inc_c");
    expect(ids).not.toContain("inc_inc_b");
    expect(ids).toContain("shift_shf_a");
    expect(ids).not.toContain("shift_shf_b");
    expect(ids).not.toContain("shift_shf_c");

    // And nothing from Salt Lake by any route.
    expect(feed.some((item) => item.zoneName === "Salt Lake Sector V")).toBe(false);
  });

  it("shows an administrator the whole network's feed", async () => {
    const feed: any[] = await service().feed(ADMIN);
    const ids = feed.map((item) => item.id);
    expect(ids).toContain("inc_inc_b");
    expect(ids).toContain("shift_shf_b");
  });
});

describe("what a vendor sees", () => {
  it("scopes incidents to their own sessions and the zones they hold", async () => {
    // The vendor branch is the one that cannot be expressed inline: an incident
    // logged against a zone carries no vendor id, so the zones they operate have
    // to be looked up first. Same shape as IncidentsService, deliberately.
    const overview: any = await service().overview(VENDOR_1);
    expect(overview.openIncidents).toBe(2);
    expect(overview.openShifts).toBe(1);
    expect(overview.awaitingVerification).toBe(1);
    expect(overview.varianceShifts).toBe(0);
  });
});

// ------------------------------------------------ what is authority-wide on purpose

describe("the figures that are deliberately authority-wide", () => {
  it("gives an officer the same numbers as an administrator", async () => {
    const officer: any = await service().overview(OFFICER);
    const admin: any = await service().overview(ADMIN);

    // None of these rows carries a zone. A vendor is an organisation the
    // authority contracts with, a citizen registers with the city, a pass is
    // honoured wherever it is valid, and a settlement is one vendor's whole
    // period across every kerb they hold — a quarter of one reconciles against
    // nothing. The portal labels all five authority-wide on the officer's
    // dashboard, and this is the case that keeps the label honest: it fails the
    // moment one of them is quietly narrowed and the wording is left behind.
    expect(officer.activeVendors).toBe(admin.activeVendors);
    expect(officer.pendingVendorApprovals).toBe(admin.pendingVendorApprovals);
    expect(officer.registeredCitizens).toBe(admin.registeredCitizens);
    expect(officer.activePasses).toBe(admin.activePasses);
    expect(officer.pendingSettlements).toBe(admin.pendingSettlements);
    expect(officer.pendingVendorPayments).toBe(admin.pendingVendorPayments);

    // Not vacuously equal — there is data on both sides of the boundary.
    expect(admin.activeVendors).toBe(2);
    expect(admin.pendingSettlements).toBe(2);
    expect(admin.registeredCitizens).toBe(2);
  });
});

// ------------------------------------------------------ the half that was right

describe("the figures that were already narrowed", () => {
  it("still counts only their own zones, sessions and takings", async () => {
    const overview: any = await service().overview(OFFICER);
    expect(overview.zonesTotal).toBe(1);
    expect(overview.totalCapacity).toBe(10);
    expect(overview.activeVehicles).toBe(1);
    expect(overview.revenueToday).toBe(6490);
  });
});
