import { UserRole } from "@prisma/client";

export const PERMISSIONS = [
  "zone.read", "zone.write", "zone.status", "slot.write",
  "session.read", "session.cancel", "incident.manage",
  "vendor.read", "vendor.write", "vendor.approve", "attendant.write", "shift.verify",
  "tariff.read", "tariff.write", "tariff.publish", "discount.write", "pass.write",
  "payment.read", "payment.refund", "settlement.read", "settlement.approve", "settlement.payout",
  "report.generate", "audit.read", "user.manage", "cms.write", "config.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The single source of truth for who may do what. The guard pre-checks it and
 * every zone-scoped service re-asserts scope — defence in depth, not decoration.
 */
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[] | "*"> = {
  SUPER_ADMIN: "*",
  ADMIN: [
    "zone.read", "zone.write", "zone.status", "slot.write",
    "session.read", "session.cancel", "incident.manage",
    "vendor.read", "vendor.write", "vendor.approve", "attendant.write", "shift.verify",
    "tariff.read", "tariff.write", "tariff.publish", "discount.write", "pass.write",
    "payment.read", "payment.refund", "settlement.read", "settlement.approve", "settlement.payout",
    "report.generate", "audit.read", "user.manage", "cms.write",
  ],
  ZONE_OFFICER: [
    "zone.read", "zone.status", "session.read", "incident.manage",
    "vendor.read", "tariff.read", "report.generate",
  ],
  AUDITOR: [
    "zone.read", "session.read", "vendor.read", "tariff.read",
    "payment.read", "settlement.read", "report.generate", "audit.read",
  ],
  VENDOR: ["zone.read", "session.read", "attendant.write", "payment.read", "settlement.read"],
  ATTENDANT: ["zone.read", "session.read"],
  CITIZEN: [],
};

export function can(role: UserRole, permission: Permission): boolean {
  const grants = ROLE_PERMISSIONS[role];
  return grants === "*" || grants.includes(permission);
}

/** Roles whose reads must always be narrowed to the zones they are assigned. */
export const ZONE_SCOPED_ROLES: UserRole[] = [
  UserRole.ZONE_OFFICER,
  UserRole.VENDOR,
  UserRole.ATTENDANT,
];

export const isZoneScoped = (role: UserRole): boolean => ZONE_SCOPED_ROLES.includes(role);
