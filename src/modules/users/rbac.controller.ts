import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { PrismaService } from "@/prisma/prisma.service";
import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { PERMISSIONS, PERMISSION_GROUPS, ungroupedPermissions } from "@/common/rbac/permissions";
import { RolesService } from "@/common/rbac/roles.service";

const CODE = /^[A-Z][A-Z0-9_]{2,39}$/;

const CreateRoleSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(CODE, "Uppercase letters, digits and underscores, starting with a letter"),
  label: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).default([]),
  isZoneScoped: z.boolean().default(false),
});
type CreateRoleDto = z.infer<typeof CreateRoleSchema>;

const UpdateRoleSchema = z.object({
  label: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().max(500).optional(),
  /** Replaces the whole list — the matrix screen sends the full set it wants. */
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
  isZoneScoped: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});
type UpdateRoleDto = z.infer<typeof UpdateRoleSchema>;

/**
 * Roles and what they may do.
 *
 * These are rows now rather than constants, so the authority can grant and
 * revoke access without waiting for a deploy. Three things are protected
 * regardless of who is asking, because each of them is a way to lock the
 * authority out of its own platform or to quietly widen someone's reach:
 *
 *  - a system role cannot be deleted or recoded; the code refers to them by name
 *  - the superuser role's permissions cannot be edited; it is unrestricted by
 *    definition, and a list would imply otherwise
 *  - a role still held by a user cannot be deleted
 *
 * Every change is written to the audit trail, and anyone holding the role is
 * signed out so the new grants apply immediately rather than whenever their
 * token happens to expire.
 */
@ApiTags("Roles & access")
@ApiBearerAuth("bearer")
@Controller("rbac")
export class RbacController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermissions("user.manage")
  @Get("matrix")
  @ApiOperation({
    summary: "Roles, permissions and who holds what",
    description: "Served from the same rows the guards read on every request.",
  })
  async matrix() {
    const [roles, counts] = await Promise.all([
      this.roles.list(),
      this.prisma.user.groupBy({ by: ["role"], where: { deletedAt: null }, _count: { _all: true } }),
    ]);
    const held = new Map(counts.map((c) => [c.role, c._count._all]));

    return {
      permissions: PERMISSIONS,
      groups: PERMISSION_GROUPS,
      roles: roles.map((role) => ({
        code: role.code,
        label: role.label,
        description: role.description,
        // Expanded so the screen need not special-case the superuser.
        permissions: role.isSuperuser ? [...PERMISSIONS] : [...role.permissions],
        unrestricted: role.isSuperuser,
        zoneScoped: role.isZoneScoped,
        isSystem: role.isSystem,
        // A role nobody holds can be deleted; one in use cannot.
        userCount: held.get(role.code) ?? 0,
        editable: !role.isSuperuser,
        deletable: !role.isSystem && (held.get(role.code) ?? 0) === 0,
      })),
      // Surfaced rather than hidden: a permission missing from every group would
      // vanish from the screen while still being enforced.
      ungrouped: ungroupedPermissions(),
      editable: true,
    };
  }

  @RequirePermissions("user.manage")
  @Post("roles")
  @ApiOperation({ summary: "Create a role" })
  async create(
    @Body(zodPipe(CreateRoleSchema)) dto: CreateRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    const clash = await this.prisma.role.findUnique({ where: { code: dto.code } });
    if (clash) {
      throw new AppException("DUPLICATE_RESOURCE", [{ field: "code", issue: "already in use" }]);
    }

    const role = await this.prisma.role.create({
      data: {
        code: dto.code,
        label: dto.label,
        description: dto.description,
        permissions: dto.permissions,
        isZoneScoped: dto.isZoneScoped,
        isSystem: false,
        isSuperuser: false,
      },
    });
    this.roles.invalidate();

    await this.audit.record({
      actor: user,
      action: "ROLE_CREATE",
      entity: "Role",
      entityId: role.code,
      after: { label: role.label, permissions: role.permissions },
      ip: info.ip,
      requestId,
    });

    return role;
  }

  @RequirePermissions("user.manage")
  @Patch("roles/:code")
  @ApiOperation({
    summary: "Change a role's permissions",
    description:
      "Everyone holding the role is signed out, so a revoked permission stops working now rather " +
      "than when their token expires.",
  })
  async update(
    @Param("code") code: string,
    @Body(zodPipe(UpdateRoleSchema)) dto: UpdateRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    const before = await this.prisma.role.findUnique({ where: { code } });
    if (!before) throw AppException.notFound("role");

    if (before.isSuperuser && dto.permissions) {
      throw AppException.forbidden(
        "The Super Admin role is unrestricted by definition. Editing its permission list would " +
          "suggest otherwise without changing anything.",
      );
    }

    const after = await this.prisma.role.update({
      where: { code },
      data: {
        ...(dto.label ? { label: dto.label } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.permissions ? { permissions: dto.permissions } : {}),
        ...(dto.isZoneScoped !== undefined ? { isZoneScoped: dto.isZoneScoped } : {}),
      },
    });
    this.roles.invalidate();

    // Only when access actually changed. Relabelling a role should not sign
    // half the authority out of the portal.
    const accessChanged =
      dto.permissions !== undefined || dto.isZoneScoped !== undefined;
    let signedOut = 0;
    if (accessChanged) {
      const holders = await this.prisma.user.findMany({ where: { role: code }, select: { id: true } });
      if (holders.length > 0) {
        const result = await this.prisma.loginSession.updateMany({
          where: { userId: { in: holders.map((h) => h.id) }, revokedAt: null },
          data: {
            revokedAt: new Date(),
            revokedReason: `Role permissions changed: ${dto.reason ?? "no reason given"}`,
          },
        });
        signedOut = result.count;
      }
    }

    await this.audit.record({
      actor: user,
      action: "ROLE_UPDATE",
      entity: "Role",
      entityId: code,
      before: { permissions: before.permissions, isZoneScoped: before.isZoneScoped, label: before.label },
      after: {
        permissions: after.permissions,
        isZoneScoped: after.isZoneScoped,
        label: after.label,
        reason: dto.reason,
        sessionsRevoked: signedOut,
      },
      ip: info.ip,
      requestId,
    });

    return { ...after, sessionsRevoked: signedOut };
  }

  @RequirePermissions("user.manage")
  @Delete("roles/:code")
  @ApiOperation({
    summary: "Delete a role",
    description: "Refused for a system role, and for any role somebody still holds.",
  })
  async remove(
    @Param("code") code: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    const role = await this.prisma.role.findUnique({ where: { code } });
    if (!role) throw AppException.notFound("role");

    if (role.isSystem) {
      throw AppException.forbidden(
        "This is a system role. The platform's own rules refer to it by name, so it cannot be removed.",
      );
    }

    const holders = await this.prisma.user.count({ where: { role: code, deletedAt: null } });
    if (holders > 0) {
      throw new AppException(
        "FORBIDDEN",
        [{ field: "code", issue: `${holders} account(s) still hold this role` }],
        "Move those accounts to another role first — otherwise they would be left unable to sign in.",
      );
    }

    await this.prisma.role.delete({ where: { code } });
    this.roles.invalidate();

    await this.audit.record({
      actor: user,
      action: "ROLE_DELETE",
      entity: "Role",
      entityId: code,
      before: { label: role.label, permissions: role.permissions },
      ip: info.ip,
      requestId,
    });

    return { deleted: true, code };
  }
}
