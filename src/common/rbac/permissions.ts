

/**
 * A role is now a row in the database, so a role code is any string — the
 * authority can create its own. These seven are seeded, referred to by name in
 * code, and cannot be deleted.
 */
export const SYSTEM_ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  ZONE_OFFICER: "ZONE_OFFICER",
  AUDITOR: "AUDITOR",
  VENDOR: "VENDOR",
  ATTENDANT: "ATTENDANT",
  CITIZEN: "CITIZEN",
} as const;

export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/** Any role code, including one the authority created. */
export type RoleCode = string;

export const PERMISSIONS = [
  "zone.read", "zone.write", "zone.status", "slot.write",
  "session.read", "session.cancel", "incident.manage",
  "vendor.read", "vendor.write", "vendor.approve", "attendant.write", "shift.verify",
  "attendant.pay.read", "attendant.pay.write",
  "tariff.read", "tariff.write", "tariff.publish", "discount.write", "pass.write",
  "payment.read", "payment.refund", "settlement.read", "settlement.approve", "settlement.payout",
  "report.generate", "audit.read", "user.manage", "cms.write", "config.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Grants used to live here. They are rows in the `Role` table now, read through
 * RolesService, so the authority can change them without a deploy.
 *
 * What remains is the catalogue: the set of permission keys the platform knows
 * how to enforce. That genuinely is code — a permission the guards never check
 * would be a checkbox that grants nothing.
 */

/**
 * Display grouping for the permission matrix screen.
 *
 * It lives beside the grants rather than in the portal so there is exactly one
 * authoritative description of who may do what. A copy in the web app would
 * drift from the copy that is actually enforced, and the screen would then
 * confidently show a matrix nothing obeys.
 */
export const PERMISSION_GROUPS: {
  key: string;
  label: string;
  permissions: { key: Permission; label: string }[];
}[] = [
  {
    key: "operations",
    label: "Operations",
    permissions: [
      { key: "zone.read", label: "View zones" },
      { key: "zone.write", label: "Create & edit zones" },
      { key: "zone.status", label: "Open / close zones" },
      { key: "slot.write", label: "Manage slots" },
      { key: "session.read", label: "View parking sessions" },
      { key: "session.cancel", label: "Cancel a session" },
      { key: "incident.manage", label: "Manage incidents" },
    ],
  },
  {
    key: "partners",
    label: "Partners",
    permissions: [
      { key: "vendor.read", label: "View vendors" },
      { key: "vendor.write", label: "Create & edit vendors" },
      { key: "vendor.approve", label: "Approve / suspend / block vendors" },
      { key: "attendant.write", label: "Manage attendants" },
      { key: "shift.verify", label: "Verify shift deposits" },
      // Held by vendors only. The permission gates the endpoint; what actually
      // keeps the authority out is that the service refuses any caller without
      // a vendorId of their own — a superuser passes every permission check by
      // definition, so a permission alone would not have been a boundary.
      { key: "attendant.pay.read", label: "View own staff payments" },
      { key: "attendant.pay.write", label: "Record a staff payment" },
    ],
  },
  {
    key: "pricing",
    label: "Pricing",
    permissions: [
      { key: "tariff.read", label: "View tariffs" },
      { key: "tariff.write", label: "Draft tariffs" },
      { key: "tariff.publish", label: "Publish tariffs" },
      { key: "discount.write", label: "Manage discounts" },
      { key: "pass.write", label: "Manage pass plans" },
    ],
  },
  {
    key: "money",
    label: "Money",
    permissions: [
      { key: "payment.read", label: "View payments" },
      { key: "payment.refund", label: "Issue refunds" },
      { key: "settlement.read", label: "View settlements" },
      { key: "settlement.approve", label: "Approve settlements" },
      { key: "settlement.payout", label: "Instruct payouts" },
    ],
  },
  {
    key: "governance",
    label: "Governance",
    permissions: [
      { key: "report.generate", label: "Generate reports" },
      { key: "audit.read", label: "Read audit trail" },
      { key: "user.manage", label: "Manage users" },
      { key: "cms.write", label: "Edit public content" },
      { key: "config.write", label: "Change system configuration" },
    ],
  },
];

/** Every permission in PERMISSIONS must appear in exactly one group. */
export function ungroupedPermissions(): Permission[] {
  const grouped = new Set(PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key)));
  return PERMISSIONS.filter((p) => !grouped.has(p));
}
