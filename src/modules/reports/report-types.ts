/**
 * Who a report can honestly be run for.
 *
 * A "zonal" report is built from parking sessions, and a session carries the
 * zone it happened in — so a ward officer running one gets a true report about
 * their own ward, just a smaller one than the authority sees.
 *
 * An "authority" report is not like that. The citizen register, the audit trail
 * and a vendor settlement are registers of the authority itself, and none of
 * the rows they read carries a zone at all: a Settlement is one vendor's whole
 * period across every kerb they hold, an AuditLog entry records who changed
 * what, and a citizen belongs to the city rather than to a ward. There is no
 * ward-sized version of them to hand back.
 */
export type ReportAudience = "zonal" | "authority";

/**
 * The report catalogue.
 *
 * It lives here rather than in the portal so there is one authoritative list:
 * a report offered by the UI that the API cannot run is a button that fails,
 * and a report the API can run that nobody can ask for is dead code.
 *
 * `audience` is part of that same contract. `ReportsService.catalogue()` reads
 * it to decide which entries a given caller is offered, and `build()` reads it
 * to decide which it will actually run, so the grid and the gate cannot drift.
 */
export const REPORT_TYPES = [
  {
    key: "revenue",
    label: "Revenue report",
    description: "Collections by day, zone, vendor and payment mode.",
    audience: "zonal",
  },
  {
    key: "occupancy",
    label: "Occupancy report",
    description: "Utilisation, peak hours and turnover per zone.",
    audience: "zonal",
  },
  {
    key: "vendor",
    label: "Vendor report",
    description: "Performance, collections and commission per vendor.",
    audience: "zonal",
  },
  {
    key: "user",
    label: "Citizen report",
    description: "Registrations, active users, repeat parking behaviour.",
    audience: "authority",
  },
  {
    key: "duration",
    label: "Parking duration report",
    description: "Duration distribution and average stay.",
    audience: "zonal",
  },
  {
    key: "daily-collection",
    label: "Daily collection",
    description: "Cash versus digital, day by day.",
    audience: "zonal",
  },
  {
    key: "monthly-collection",
    label: "Monthly collection",
    description: "Month-end consolidated collection statement.",
    audience: "zonal",
  },
  {
    key: "government-revenue",
    label: "Government revenue",
    description: "Municipal share after commission, by vendor.",
    audience: "zonal",
  },
  {
    key: "settlement",
    label: "Vendor settlement",
    description: "Settlement lines, commission and payout status.",
    audience: "authority",
  },
  {
    key: "tax",
    label: "Tax report",
    description: "Tax collected, receipt-wise.",
    audience: "zonal",
  },
  {
    key: "audit",
    label: "Audit report",
    description: "Complete before/after trail for a period.",
    audience: "authority",
  },
] as const;

export type ReportKey = (typeof REPORT_TYPES)[number]["key"];

export function reportAudience(key: string): ReportAudience {
  // An unknown key is treated as authority-wide. A report that is not in the
  // catalogue cannot be shown to have a zone in it, and the safe reading of
  // "we do not know what this is" is not "show it to everybody".
  return REPORT_TYPES.find((t) => t.key === key)?.audience ?? "authority";
}

export const REPORT_KEYS = REPORT_TYPES.map((t) => t.key) as unknown as [ReportKey, ...ReportKey[]];

export function reportLabel(key: string): string {
  return REPORT_TYPES.find((t) => t.key === key)?.label ?? key;
}
