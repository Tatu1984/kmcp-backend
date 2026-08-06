import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";

import { RequirePermissions } from "@/common/decorators/auth.decorators";
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  ROLE_PERMISSIONS,
  ZONE_SCOPED_ROLES,
  ungroupedPermissions,
} from "@/common/rbac/permissions";

const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Administrator",
  ZONE_OFFICER: "Zone Officer",
  AUDITOR: "Auditor",
  VENDOR: "Vendor",
  ATTENDANT: "Attendant",
  CITIZEN: "Citizen",
};

const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  SUPER_ADMIN: "Unrestricted. Can change roles and system configuration.",
  ADMIN: "Runs day-to-day operations, money and partners. Cannot change system configuration.",
  ZONE_OFFICER: "Sees and operates only the zones assigned to them.",
  AUDITOR: "Read-only across the platform, including the audit trail.",
  VENDOR: "Their own organisation: zones held, staff, collections and settlements.",
  ATTENDANT: "The kerb. Starts and ends parking sessions on a bound device.",
  CITIZEN: "The public app. No portal access at all.",
};

/**
 * The authorization matrix, served from the same constants the guards enforce.
 *
 * This exists so the portal can render what is actually true rather than its own
 * copy of it. A permissions screen that disagrees with the server is worse than
 * no permissions screen — it tells an administrator a change took effect when
 * nothing changed.
 *
 * Read-only by design. The matrix is code: it is reviewed, versioned and
 * deployed, not edited in production by whoever is holding an admin login.
 */
@ApiTags("RBAC")
@ApiBearerAuth("bearer")
@Controller("rbac")
export class RbacController {
  @RequirePermissions("user.manage")
  @Get("matrix")
  @ApiOperation({
    summary: "Roles, permissions and who holds what",
    description: "The single source of truth. Not editable through the API.",
  })
  matrix() {
    return {
      permissions: PERMISSIONS,
      groups: PERMISSION_GROUPS,
      roles: (Object.keys(ROLE_PERMISSIONS) as UserRole[]).map((role) => {
        const grants = ROLE_PERMISSIONS[role];
        return {
          role,
          label: ROLE_LABELS[role],
          description: ROLE_DESCRIPTIONS[role],
          /** "*" means unrestricted — expanded here so the UI need not special-case it. */
          unrestricted: grants === "*",
          permissions: grants === "*" ? [...PERMISSIONS] : [...grants],
          zoneScoped: ZONE_SCOPED_ROLES.includes(role),
        };
      }),
      // Surfaced rather than hidden: a permission missing from every group would
      // silently vanish from the screen while still being enforced.
      ungrouped: ungroupedPermissions(),
      editable: false,
    };
  }
}
