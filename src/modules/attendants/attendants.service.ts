import { Injectable } from "@nestjs/common";
import { SYSTEM_ROLES, type RoleCode } from "@/common/rbac/permissions";
import { Prisma, SessionStatus, ShiftStatus, UserStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { scoped, zoneScopeOf } from "@/common/rbac/scope";
import type {
  AttendantQueryDto,
  AttendantStatusDto,
  CreateAttendantDto,
  TransferAttendantDto,
  UpdateAttendantDto,
} from "./dto/attendant.dto";

/**
 * A removed attendant is soft-deleted through `User.deletedAt`, so every query
 * that builds a roster has to say it does not want them. Kept as one constant
 * rather than repeated inline: a listing that forgets it shows a person who has
 * been dismissed, next to live staff, with a working-looking row.
 */
const NOT_REMOVED = { user: { deletedAt: null } } satisfies Prisma.AttendantWhereInput;

type Ctx = { ip?: string; requestId?: string };

const SORTABLE = ["employeeCode", "createdAt", "isActive"] as const;

const ATTENDANT_SELECT = {
  id: true,
  userId: true,
  vendorId: true,
  employeeCode: true,
  defaultZoneId: true,
  isActive: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      status: true,
      lastLoginAt: true,
      /**
       * The handsets this account is bound to, live ones only.
       *
       * Carried on the *list* and not only the detail endpoint, because device
       * binding is a roster-wide question — "who is sharing a login" is asked
       * of everybody at once, never of one person you already suspect. Without
       * it the portal had a Device column, a Bound/Unbound filter, an unbound
       * count and an Unbind action, all reading a field the list never sent:
       * every attendant rendered as "Not bound", and the Unbind action, hidden
       * behind that same field, could not be reached for anyone.
       *
       * Inactive rows are excluded rather than returned with a flag: an unbound
       * device is a historical fact for the audit trail, not something the
       * roster should offer to unbind again.
       */
      devices: {
        where: { isActive: true },
        select: { id: true, platform: true, appVersion: true, lastSeenAt: true },
        orderBy: { lastSeenAt: "desc" },
      },
    },
  },
  vendor: { select: { id: true, orgName: true, status: true } },
} satisfies Prisma.AttendantSelect;

/**
 * Attendants are the people at the kerb. Each one is a vendor's employee with a
 * login of their own, because every session, every rupee of cash and every
 * photograph has to be attributable to a named individual.
 */
@Injectable()
export class AttendantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A vendor only ever sees their own staff; a zone officer only sees the staff
   * posted to a ward they hold.
   *
   * The zone half was missing, and the omission was easy to overlook because
   * attendants are filed under an operator rather than a kerb. The effect was
   * that an officer allocated no wards — who correctly saw no zones, no
   * sessions and no bays — could still list every attendant in the city by
   * name and mobile number, because `vendor.read` was the only gate and this
   * filter had nothing to say about zones.
   *
   * An attendant with no default zone is not visible to a scoped officer.
   * `{ in: [] }` on an empty allocation already matches nothing; excluding the
   * unposted ones as well keeps "shown" meaning "in a ward you hold".
   */
  private scopeFilter(user: AuthenticatedUser): Prisma.AttendantWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) {
      return { vendorId: user.vendorId };
    }
    const zoneIds = zoneScopeOf(user);
    return zoneIds === null ? {} : { defaultZoneId: { in: zoneIds } };
  }

  private assertOwnership(vendorId: string, user: AuthenticatedUser) {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId !== vendorId) {
      throw AppException.forbidden("This attendant belongs to another vendor.");
    }
  }

  async list(query: AttendantQueryDto, user: AuthenticatedUser) {
    // `?vendorId=` collides with the scope's own key, so a vendor asking for
    // somebody else's id used to replace their scope rather than narrow it and
    // list another operator's staff, names and mobile numbers included.
    const where = scoped<Prisma.AttendantWhereInput>(this.scopeFilter(user), {
      ...NOT_REMOVED,
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.zoneId ? { defaultZoneId: query.zoneId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.onShift ? { shifts: { some: { status: ShiftStatus.OPEN } } } : {}),
      ...(query.q
        ? {
            OR: [
              { employeeCode: { contains: query.q, mode: "insensitive" } },
              { user: { name: { contains: query.q, mode: "insensitive" } } },
              { user: { phone: { contains: query.q } } },
            ],
          }
        : {}),
    });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendant.findMany({
        where,
        select: ATTENDANT_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { employeeCode: "asc" }),
        ...skipTake(query),
      }),
      this.prisma.attendant.count({ where }),
    ]);

    // One query for open shifts rather than a subquery per row.
    const openShifts = await this.prisma.shift.findMany({
      where: { attendantId: { in: rows.map((r) => r.id) }, status: ShiftStatus.OPEN },
      select: { attendantId: true, id: true, startAt: true, zoneId: true },
    });
    const shiftBy = new Map(openShifts.map((s) => [s.attendantId, s]));

    return new Paginated(
      rows.map((row) => ({ ...row, onShift: shiftBy.get(row.id) ?? null })),
      query.page,
      query.pageSize,
      total,
    );
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const attendant = await this.prisma.attendant.findFirst({
      where: { id, ...NOT_REMOVED },
      select: {
        ...ATTENDANT_SELECT,
        _count: { select: { sessions: true, shifts: true } },
      },
    });
    if (!attendant) throw AppException.notFound("attendant");
    this.assertOwnership(attendant.vendorId, user);

    const [openShift, devices] = await Promise.all([
      this.prisma.shift.findFirst({
        where: { attendantId: id, status: ShiftStatus.OPEN },
        select: { id: true, startAt: true, zoneId: true, sessionsCount: true, cashExpected: true },
      }),
      this.prisma.device.findMany({
        where: { userId: attendant.userId },
        select: { id: true, platform: true, appVersion: true, lastSeenAt: true, isActive: true },
        orderBy: { lastSeenAt: "desc" },
      }),
    ]);

    const { _count, ...rest } = attendant;
    return {
      ...rest,
      sessionCount: _count.sessions,
      shiftCount: _count.shifts,
      onShift: openShift,
      devices,
    };
  }

  async create(dto: CreateAttendantDto, actor: AuthenticatedUser, ctx: Ctx) {
    this.assertOwnership(dto.vendorId, actor);

    const vendor = await this.prisma.vendor.findUnique({ where: { id: dto.vendorId } });
    if (!vendor) throw AppException.notFound("vendor");
    if (vendor.status !== "APPROVED") {
      throw new AppException(
        "KYC_INCOMPLETE",
        [{ field: "vendorId", issue: `vendor is ${vendor.status}` }],
        "Only an approved vendor can put staff on the kerb.",
      );
    }

    /**
     * A removed attendant keeps their number and their code, because their old
     * shifts and cash collections still point at them. That makes the clash
     * invisible: the officer has just taken somebody off the roster, cannot see
     * them in any listing, and is told the number is "already registered". So
     * when the row that clashes is a removed one, the message says so.
     */
    const [phoneClash, codeClash] = await Promise.all([
      this.prisma.user.findUnique({
        where: { phone: dto.phone },
        select: { name: true, deletedAt: true },
      }),
      this.prisma.attendant.findUnique({
        where: { employeeCode: dto.employeeCode },
        select: { user: { select: { name: true, deletedAt: true } } },
      }),
    ]);
    // These two *are* fields on the form in front of the officer, so they keep
    // their `details` and the explanation is folded into the issue itself —
    // a message alongside a detail would never be shown (see `remove()`).
    if (phoneClash) {
      throw new AppException("DUPLICATE_RESOURCE", [
        {
          field: "phone",
          issue: phoneClash.deletedAt
            ? `still held by ${phoneClash.name}, who was removed. A removed account keeps its number so their sessions and cash stay attributable — use a different number`
            : "already registered",
        },
      ]);
    }
    if (codeClash) {
      throw new AppException("DUPLICATE_RESOURCE", [
        {
          field: "employeeCode",
          issue: codeClash.user.deletedAt
            ? `still held by ${codeClash.user.name}, who was removed. Codes are not reused, so their old shifts stay readable — choose another`
            : "already in use",
        },
      ]);
    }

    // The login and the employment record are created together — an attendant
    // who cannot sign in cannot start a session, so a half-made one is useless.
    const attendant = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name,
          phone: dto.phone,
          email: dto.email?.toLowerCase(),
          role: SYSTEM_ROLES.ATTENDANT,
          status: UserStatus.ACTIVE,
          passwordHash: dto.password ? await bcrypt.hash(dto.password, 12) : null,
        },
      });

      return tx.attendant.create({
        data: {
          userId: user.id,
          vendorId: dto.vendorId,
          employeeCode: dto.employeeCode,
          defaultZoneId: dto.defaultZoneId,
        },
        select: ATTENDANT_SELECT,
      });
    });

    await this.audit.record({
      actor,
      action: "ATTENDANT_CREATE",
      entity: "Attendant",
      entityId: attendant.id,
      after: { employeeCode: attendant.employeeCode, vendorId: attendant.vendorId, name: dto.name },
      ...ctx,
    });

    return attendant;
  }

  async update(id: string, dto: UpdateAttendantDto, actor: AuthenticatedUser, ctx: Ctx) {
    const before = await this.prisma.attendant.findFirst({
      where: { id, ...NOT_REMOVED },
      select: ATTENDANT_SELECT,
    });
    if (!before) throw AppException.notFound("attendant");
    this.assertOwnership(before.vendorId, actor);

    if (dto.employeeCode && dto.employeeCode !== before.employeeCode) {
      const clash = await this.prisma.attendant.findUnique({ where: { employeeCode: dto.employeeCode } });
      if (clash) {
        throw new AppException("DUPLICATE_RESOURCE", [{ field: "employeeCode", issue: "already in use" }]);
      }
    }

    const after = await this.prisma.$transaction(async (tx) => {
      if (dto.name || dto.phone || dto.email) {
        await tx.user.update({
          where: { id: before.userId },
          data: {
            ...(dto.name ? { name: dto.name } : {}),
            ...(dto.phone ? { phone: dto.phone } : {}),
            ...(dto.email ? { email: dto.email.toLowerCase() } : {}),
          },
        });
      }
      return tx.attendant.update({
        where: { id },
        data: {
          ...(dto.employeeCode ? { employeeCode: dto.employeeCode } : {}),
          ...(dto.defaultZoneId !== undefined ? { defaultZoneId: dto.defaultZoneId } : {}),
        },
        select: ATTENDANT_SELECT,
      });
    });

    await this.audit.record({
      actor,
      action: "ATTENDANT_UPDATE",
      entity: "Attendant",
      entityId: id,
      before,
      after,
      ...ctx,
    });

    return after;
  }

  /**
   * Deactivation is refused mid-shift. An attendant with an open shift is
   * holding cash the municipality has not counted yet — close the shift first.
   */
  async setActive(id: string, dto: AttendantStatusDto, actor: AuthenticatedUser, ctx: Ctx) {
    const attendant = await this.prisma.attendant.findFirst({
      where: { id, ...NOT_REMOVED },
      select: ATTENDANT_SELECT,
    });
    if (!attendant) throw AppException.notFound("attendant");
    this.assertOwnership(attendant.vendorId, actor);

    if (!dto.isActive) {
      const open = await this.prisma.shift.count({ where: { attendantId: id, status: ShiftStatus.OPEN } });
      if (open > 0) {
        // No `details`: see the note in `remove()`. A detail here is rendered
        // in place of the message, as "Is Active: the attendant has an open
        // shift", which loses the only part that says what to do about it.
        throw new AppException(
          "SHIFT_ALREADY_OPEN",
          undefined,
          "Close and reconcile their open shift before deactivating this attendant.",
        );
      }
    }

    const after = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: attendant.userId },
        data: { status: dto.isActive ? UserStatus.ACTIVE : UserStatus.SUSPENDED },
      });
      // Sign them out everywhere: a deactivated attendant must not keep working
      // on a token issued before the decision.
      if (!dto.isActive) {
        await tx.loginSession.updateMany({
          where: { userId: attendant.userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: dto.reason },
        });
        await tx.device.updateMany({ where: { userId: attendant.userId }, data: { isActive: false } });
      }
      return tx.attendant.update({
        where: { id },
        data: { isActive: dto.isActive },
        select: ATTENDANT_SELECT,
      });
    });

    await this.audit.record({
      actor,
      action: dto.isActive ? "ATTENDANT_ACTIVATE" : "ATTENDANT_DEACTIVATE",
      entity: "Attendant",
      entityId: id,
      before: { isActive: attendant.isActive },
      after: { isActive: dto.isActive, reason: dto.reason },
      ...ctx,
    });

    return after;
  }

  /**
   * Removes an attendant from service.
   *
   * "Delete" means here what it means everywhere else in this codebase — see
   * `ZonesService.remove` — the row survives. It has to: `Shift` and
   * `AttendantPayment` both hold a *required* foreign key to `Attendant`, so a
   * real DELETE would be refused by the database for anybody who has ever
   * worked a shift, and forcing it through would take a night's counted cash
   * and a chain of evidence photographs with it. Every session, every rupee and
   * every photograph has to stay attributable to a named person; that is the
   * whole reason attendants have logins of their own.
   *
   * What is removed is their access and their place on the roster, through
   * `User.deletedAt` — which every read path already honours, sign-in and token
   * refresh included. So the effect is immediate and complete: no password
   * works, no already-issued token survives its next refresh, no handset stays
   * bound, and they leave every listing.
   */
  async remove(id: string, reason: string, actor: AuthenticatedUser, ctx: Ctx) {
    const attendant = await this.prisma.attendant.findFirst({
      where: { id, ...NOT_REMOVED },
      select: ATTENDANT_SELECT,
    });
    if (!attendant) throw AppException.notFound("attendant");
    this.assertOwnership(attendant.vendorId, actor);

    // The same two questions deactivation asks, and for the same reasons: cash
    // nobody has counted, and a car on the ground with no one attached to it.
    const [openShifts, liveSessions] = await Promise.all([
      this.prisma.shift.count({ where: { attendantId: id, status: ShiftStatus.OPEN } }),
      this.prisma.parkingSession.count({
        where: { attendantId: id, status: { in: [SessionStatus.ACTIVE, SessionStatus.OVERSTAY] } },
      }),
    ]);
    /**
     * No `details` on either of these, deliberately.
     *
     * `details` is field-level information, for a form that can highlight the
     * input at fault — and the client's error formatter treats it that way: if
     * details are present it renders them *instead of* the message, as
     * "Field: issue". Neither of these refusals is about a field the officer
     * typed. Attaching one turned a sentence that says what to do next into
     * "Id: the attendant has an open shift", which says nothing about how to
     * proceed. The message is the whole answer here, so it travels alone.
     */
    if (openShifts > 0) {
      throw new AppException(
        "SHIFT_ALREADY_OPEN",
        undefined,
        "Close and reconcile their open shift before removing this attendant.",
      );
    }
    if (liveSessions > 0) {
      throw new AppException(
        "VALIDATION_FAILED",
        undefined,
        `End the ${liveSessions} session${liveSessions === 1 ? "" : "s"} still running under this attendant first, then remove them.`,
      );
    }

    const removedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: attendant.userId },
        data: { deletedAt: removedAt, status: UserStatus.SUSPENDED },
      });
      await tx.loginSession.updateMany({
        where: { userId: attendant.userId, revokedAt: null },
        data: { revokedAt: removedAt, revokedReason: `Removed: ${reason}` },
      });
      await tx.device.updateMany({ where: { userId: attendant.userId }, data: { isActive: false } });
      await tx.attendant.update({ where: { id }, data: { isActive: false } });
    });

    await this.audit.record({
      actor,
      action: "ATTENDANT_REMOVE",
      entity: "Attendant",
      entityId: id,
      // Their identifiers go into the record because no roster will show them
      // again: this entry becomes the only readable account of who was removed.
      before: {
        employeeCode: attendant.employeeCode,
        name: attendant.user.name,
        phone: attendant.user.phone,
        vendorId: attendant.vendorId,
        isActive: attendant.isActive,
      },
      after: { removedAt: removedAt.toISOString(), reason },
      ...ctx,
    });

    return { removed: true, id, employeeCode: attendant.employeeCode };
  }

  /**
   * Releases every device bound to an attendant.
   *
   * Device binding is what stops one attendant login being shared around a
   * team. When a handset is lost or replaced the binding has to be broken
   * deliberately, by a named person, with a reason — so this is an endpoint of
   * its own rather than a side effect of editing a record.
   */
  async unbindDevices(id: string, reason: string, actor: AuthenticatedUser, ctx: Ctx) {
    const attendant = await this.prisma.attendant.findFirst({
      where: { id, ...NOT_REMOVED },
      select: ATTENDANT_SELECT,
    });
    if (!attendant) throw AppException.notFound("attendant");
    this.assertOwnership(attendant.vendorId, actor);

    const { count } = await this.prisma.device.updateMany({
      where: { userId: attendant.userId, isActive: true },
      data: { isActive: false },
    });

    // The old device keeps a valid access token until it expires, so the
    // sessions go too — otherwise "unbound" means "unbound in about an hour".
    await this.prisma.loginSession.updateMany({
      where: { userId: attendant.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: `Device unbound: ${reason}` },
    });

    await this.audit.record({
      actor,
      action: "ATTENDANT_DEVICE_UNBIND",
      entity: "Attendant",
      entityId: id,
      after: { devicesReleased: count, reason },
      ...ctx,
    });

    return { unbound: true, devicesReleased: count };
  }

  /** Moving staff between contractors — the history stays with the attendant. */
  async transfer(id: string, dto: TransferAttendantDto, actor: AuthenticatedUser, ctx: Ctx) {
    const attendant = await this.prisma.attendant.findFirst({
      where: { id, ...NOT_REMOVED },
      select: ATTENDANT_SELECT,
    });
    if (!attendant) throw AppException.notFound("attendant");

    const vendor = await this.prisma.vendor.findUnique({ where: { id: dto.vendorId } });
    if (!vendor) throw AppException.notFound("vendor");
    if (vendor.status !== "APPROVED") {
      throw new AppException("KYC_INCOMPLETE", [{ field: "vendorId", issue: `vendor is ${vendor.status}` }]);
    }

    const open = await this.prisma.shift.count({ where: { attendantId: id, status: ShiftStatus.OPEN } });
    if (open > 0) {
      throw new AppException(
        "SHIFT_ALREADY_OPEN",
        undefined,
        "Close the open shift before transferring this attendant — its cash belongs to the current vendor.",
      );
    }

    const after = await this.prisma.attendant.update({
      where: { id },
      data: { vendorId: dto.vendorId, defaultZoneId: null },
      select: ATTENDANT_SELECT,
    });

    await this.audit.record({
      actor,
      action: "ATTENDANT_TRANSFER",
      entity: "Attendant",
      entityId: id,
      before: { vendorId: attendant.vendorId },
      after: { vendorId: dto.vendorId, reason: dto.reason },
      ...ctx,
    });

    return after;
  }
}
