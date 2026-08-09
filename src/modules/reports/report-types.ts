/**
 * The report catalogue.
 *
 * It lives here rather than in the portal so there is one authoritative list:
 * a report offered by the UI that the API cannot run is a button that fails,
 * and a report the API can run that nobody can ask for is dead code.
 */
export const REPORT_TYPES = [
  {
    key: "revenue",
    label: "Revenue report",
    description: "Collections by day, zone, vendor and payment mode.",
  },
  {
    key: "occupancy",
    label: "Occupancy report",
    description: "Utilisation, peak hours and turnover per zone.",
  },
  {
    key: "vendor",
    label: "Vendor report",
    description: "Performance, collections and commission per vendor.",
  },
  {
    key: "user",
    label: "Citizen report",
    description: "Registrations, active users, repeat parking behaviour.",
  },
  {
    key: "duration",
    label: "Parking duration report",
    description: "Duration distribution and average stay.",
  },
  {
    key: "daily-collection",
    label: "Daily collection",
    description: "Cash versus digital, day by day.",
  },
  {
    key: "monthly-collection",
    label: "Monthly collection",
    description: "Month-end consolidated collection statement.",
  },
  {
    key: "government-revenue",
    label: "Government revenue",
    description: "Municipal share after commission, by vendor.",
  },
  {
    key: "settlement",
    label: "Vendor settlement",
    description: "Settlement lines, commission and payout status.",
  },
  {
    key: "tax",
    label: "Tax report",
    description: "Tax collected, receipt-wise.",
  },
  {
    key: "audit",
    label: "Audit report",
    description: "Complete before/after trail for a period.",
  },
] as const;

export type ReportKey = (typeof REPORT_TYPES)[number]["key"];

export const REPORT_KEYS = REPORT_TYPES.map((t) => t.key) as unknown as [ReportKey, ...ReportKey[]];

export function reportLabel(key: string): string {
  return REPORT_TYPES.find((t) => t.key === key)?.label ?? key;
}
