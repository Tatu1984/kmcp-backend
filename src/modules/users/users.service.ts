import { Injectable } from "@nestjs/common";
import { SYSTEM_ROLES, type RoleCode } from "@/common/rbac/permissions";
import { Prisma, UserStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { STAFF_ROLES } from "./dto/user.dto";
import type {
  AssignZonesDto,
  ChangeRoleDto,
  ChangeUserStatusDto,
  CreateUserDto,
  ResetPasswordDto,
  UpdateUserDto,
  UserQueryDto,
} from "./dto/user.dto";

type Ctx = { ip?: string; requestId?: string };

const SORTABLE = ["name", "email", "role", "status", "createdAt", "lastLoginAt"] as const;

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  twoFactorEnabled: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

const zoneScopeKey = (userId: string) => `zoneScope:${userId}`;

/**
 * Portal staff administration.
 *
 * The rules here exist because this is the one screen that can lock the
 * authority out of its own system: nobody edits their own role or status, and
 * the last active Super Admin cannot be removed by anyone.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private assertNotSelf(targetId: string, actor: AuthenticatedUser, what: string) {
    if (targetId === actor.id) {
      throw AppException.forbidden(`You cannot change your own ${what}. Ask another administrator.`);
    }
  }

  /** Refuses anything that would leave the platform with no active Super Admin. */
  private async assertNotLastSuperAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (user?.role !== SYSTEM_ROLES.SUPER_ADMIN) return;

    const remaining = await this.prisma.user.count({
      where: {
        role: SYSTEM_ROLES.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        id: { not: userId },
      },
    });
    if (remaining === 0) {
      throw AppException.forbidden(
        "This is the last active Super Admin. Promote someone else before changing this account.",
      );
    }
  }

  async list(query: UserQueryDto) {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(query.staffOnly ? { role: { in: [...STAFF_ROLES] } } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { email: { contains: query.q, mode: "insensitive" } },
              { phone: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { name: "asc" }),
        ...skipTake(query),
      }),
      this.prisma.user.count({ where }),
    ]);

    return new Paginated(rows, query.page, query.pageSize, total);
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: USER_SELECT,
    });
    if (!user) throw AppException.notFound("user");

    const [zoneIds, sessions, devices] = await Promise.all([
      this.zoneScope(id),
      this.prisma.loginSession.count({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      this.prisma.device.count({ where: { userId: id, isActive: true } }),
    ]);

    return { ...user, zoneIds, liveSessions: sessions, activeDevices: devices };
  }

  async create(dto: CreateUserDto, actor: AuthenticatedUser, ctx: Ctx) {
    const clash = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (clash) throw new AppException("DUPLICATE_RESOURCE", [{ field: "email", issue: "already registered" }]);

    if (dto.phone) {
      const phoneClash = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
      if (phoneClash) {
        throw new AppException("DUPLICATE_RESOURCE", [{ field: "phone", issue: "already registered" }]);
      }
    }

    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        role: dto.role,
        status: UserStatus.ACTIVE,
        passwordHash: await bcrypt.hash(dto.password, 12),
      },
      select: USER_SELECT,
    });

    if (dto.role === SYSTEM_ROLES.ZONE_OFFICER && dto.zoneIds?.length) {
      await this.setZoneScope(user.id, dto.zoneIds);
    }

    await this.audit.record({
      actor,
      action: "USER_CREATE",
      entity: "User",
      entityId: user.id,
      after: { name: user.name, email: user.email, role: user.role },
      ...ctx,
    });

    return user;
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthenticatedUser, ctx: Ctx) {
    const before = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: USER_SELECT });
    if (!before) throw AppException.notFound("user");

    if (dto.email && dto.email !== before.email) {
      const clash = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (clash) throw new AppException("DUPLICATE_RESOURCE", [{ field: "email", issue: "already registered" }]);
    }

    const after = await this.prisma.user.update({ where: { id }, data: dto, select: USER_SELECT });

    await this.audit.record({
      actor,
      action: "USER_UPDATE",
      entity: "User",
      entityId: id,
      before,
      after,
      ...ctx,
    });

    return after;
  }

  async changeRole(id: string, dto: ChangeRoleDto, actor: AuthenticatedUser, ctx: Ctx) {
    this.assertNotSelf(id, actor, "role");

    const before = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: USER_SELECT });
    if (!before) throw AppException.notFound("user");
    if (before.role === dto.role) return before;

    if (!STAFF_ROLES.includes(before.role as (typeof STAFF_ROLES)[number])) {
      throw AppException.forbidden(
        "This account is a vendor, attendant or citizen. Change it through its own screen, not user administration.",
      );
    }
    await this.assertNotLastSuperAdmin(id);

    const after = await this.prisma.user.update({
      where: { id },
      data: { role: dto.role },
      select: USER_SELECT,
    });

    // Permissions are read from the role on every request, but the old token
    // still names the old role — end the sessions so the change takes effect now.
    await this.prisma.loginSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: `Role changed: ${dto.reason}` },
    });

    if (dto.role !== SYSTEM_ROLES.ZONE_OFFICER) {
      await this.prisma.systemConfig.deleteMany({ where: { key: zoneScopeKey(id) } });
    }

    await this.audit.record({
      actor,
      action: "USER_ROLE_CHANGE",
      entity: "User",
      entityId: id,
      before: { role: before.role },
      after: { role: dto.role, reason: dto.reason },
      ...ctx,
    });

    return after;
  }

  async changeStatus(id: string, dto: ChangeUserStatusDto, actor: AuthenticatedUser, ctx: Ctx) {
    this.assertNotSelf(id, actor, "status");

    const before = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: USER_SELECT });
    if (!before) throw AppException.notFound("user");

    if (dto.status !== UserStatus.ACTIVE) await this.assertNotLastSuperAdmin(id);

    const after = await this.prisma.user.update({
      where: { id },
      data: { status: dto.status },
      select: USER_SELECT,
    });

    if (dto.status !== UserStatus.ACTIVE) {
      await this.prisma.loginSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: dto.reason },
      });
    }

    await this.audit.record({
      actor,
      action: "USER_STATUS_CHANGE",
      entity: "User",
      entityId: id,
      before: { status: before.status },
      after: { status: dto.status, reason: dto.reason },
      ...ctx,
    });

    return after;
  }

  /**
   * An administrator setting a password for someone else. Every session is ended,
   * because the point of a reset is usually that the old one is compromised.
   */
  async resetPassword(id: string, dto: ResetPasswordDto, actor: AuthenticatedUser, ctx: Ctx) {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: USER_SELECT });
    if (!user) throw AppException.notFound("user");

    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(dto.password, 12) },
    });

    await this.prisma.loginSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: `Password reset: ${dto.reason}` },
    });

    await this.audit.record({
      actor,
      action: "USER_PASSWORD_RESET",
      entity: "User",
      entityId: id,
      // The password itself is never recorded, only that it was changed and why.
      after: { reason: dto.reason, sessionsRevoked: true },
      ...ctx,
    });

    return { reset: true, id, sessionsRevoked: true };
  }

  async zoneScope(userId: string): Promise<string[]> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key: zoneScopeKey(userId) } });
    return Array.isArray(row?.value) ? (row.value as string[]) : [];
  }

  private async setZoneScope(userId: string, zoneIds: string[]) {
    await this.prisma.systemConfig.upsert({
      where: { key: zoneScopeKey(userId) },
      create: { key: zoneScopeKey(userId), value: zoneIds },
      update: { value: zoneIds },
    });
  }

  /** Which kerb a zone officer may see. Empty means unrestricted. */
  async assignZones(id: string, dto: AssignZonesDto, actor: AuthenticatedUser, ctx: Ctx) {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: USER_SELECT });
    if (!user) throw AppException.notFound("user");
    if (user.role !== SYSTEM_ROLES.ZONE_OFFICER) {
      throw AppException.forbidden("Only a zone officer carries a zone list. Other roles are not zone-scoped.");
    }

    if (dto.zoneIds.length > 0) {
      const found = await this.prisma.zone.count({ where: { id: { in: dto.zoneIds } } });
      if (found !== dto.zoneIds.length) {
        throw new AppException("NOT_FOUND", [{ field: "zoneIds", issue: "one or more zones do not exist" }]);
      }
    }

    const before = await this.zoneScope(id);
    await this.setZoneScope(id, dto.zoneIds);

    await this.audit.record({
      actor,
      action: "USER_ZONE_SCOPE",
      entity: "User",
      entityId: id,
      before: { zoneIds: before },
      after: { zoneIds: dto.zoneIds },
      ...ctx,
    });

    return { id, zoneIds: dto.zoneIds };
  }
}
