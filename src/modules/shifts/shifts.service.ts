import { Injectable, Logger } from "@nestjs/common";
import { PaymentMode, PaymentStatus, Prisma, ShiftStatus } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import { SYSTEM_ROLES } from "@/common/rbac/permissions";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { scoped, zoneScopeOf } from "@/common/rbac/scope";
import type { CloseShiftDto, OpenShiftDto, ShiftQueryDto, VerifyShiftDto } from "./dto/shift.dto";

type Ctx = { ip?: string; requestId?: string };

const SORTABLE = ["startAt", "endAt", "cashExpected", "varianceAmount", "status"] as const;

const SHIFT_SELECT = {
  id: true,
  attendantId: true,
  vendorId: true,
  zoneId: true,
  startAt: true,
  endAt: true,
  startLat: true,
  startLng: true,
  endLat: true,
  endLng: true,
  sessionsCount: true,
  cashExpected: true,
  cashDeposited: true,
  digitalTotal: true,
  varianceAmount: true,
  status: true,
  verifiedBy: true,
  verifiedAt: true,
  attendant: {
    select: { id: true, employeeCode: true, user: { select: { name: true, phone: true } } },
  },
  vendor: { select: { id: true, orgName: true } },
  zone: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ShiftSelect;

/**
 * A shift is the unit of accountability for cash.
 *
 * An attendant opens one when they start work and closes it by declaring what
 * they are handing in. The system already knows what it thinks was collected,
 * so the close is a comparison, not a report — and any gap between the two is
 * recorded as a variance under a named person rather than quietly absorbed.
 *
 * This is the part of the platform an auditor will look at first, so nothing
 * here rounds, nets off, or silently corrects.
 */
@Injectable()
export class ShiftsService {
  private readonly logger = new Logger(ShiftsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private scopeFilter(user: AuthenticatedUser): Prisma.ShiftWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) return { vendorId: user.vendorId };
    if (user.role === SYSTEM_ROLES.ATTENDANT && user.attendantId) {
      return { attendantId: user.attendantId };
    }
    const zones = zoneScopeOf(user);
    return zones ? { zoneId: { in: zones } } : {};
  }

  /**
   * Recomputes what the shift took, from the payments themselves.
   *
   * The running totals on the row are maintained as money comes in, but a close
   * recalculates from the payments rather than trusting them — an increment
   * that failed to apply would otherwise become a variance the attendant is
   * asked to explain.
   */
  private async collected(shiftId: string): Promise<{ cash: number; digital: number; sessions: number }> {
    const [byMode, sessions] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ["mode"],
        where: {
          shiftId,
          status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
        },
        _sum: { amount: true, refundedAmount: true },
      }),
      this.prisma.parkingSession.count({ where: { shiftId } }),
    ]);

    const net = (mode: (typeof byMode)[number]) =>
      (mode._sum.amount ?? 0) - (mode._sum.refundedAmount ?? 0);

    return {
      cash: byMode.filter((m) => m.mode === PaymentMode.CASH).reduce((s, m) => s + net(m), 0),
      digital: byMode.filter((m) => m.mode !== PaymentMode.CASH).reduce((s, m) => s + net(m), 0),
      sessions,
    };
  }

  async open(dto: OpenShiftDto, user: AuthenticatedUser, ctx: Ctx) {
    if (!user.attendantId) {
      throw AppException.forbidden("Only an attendant opens a shift.");
    }

    // One open shift per attendant. Two would split a day's cash across
    // records that nobody could later reconcile against a single deposit.
    const existing = await this.prisma.shift.findFirst({
      where: { attendantId: user.attendantId, status: ShiftStatus.OPEN },
      select: SHIFT_SELECT,
    });
    if (existing) {
      // Idempotent by nature: a handset retrying "start shift" gets the shift
      // it already has rather than an error it cannot act on.
      return { ...existing, alreadyOpen: true };
    }

    const attendant = await this.prisma.attendant.findUnique({
      where: { id: user.attendantId },
      select: { id: true, vendorId: true, isActive: true, defaultZoneId: true },
    });
    if (!attendant) throw AppException.notFound("attendant");
    if (!attendant.isActive) {
      throw AppException.forbidden("This attendant account is not active.");
    }

    const shift = await this.prisma.shift.create({
      data: {
        attendantId: attendant.id,
        vendorId: attendant.vendorId,
        zoneId: dto.zoneId ?? attendant.defaultZoneId,
        startAt: new Date(),
        startLat: dto.location?.lat,
        startLng: dto.location?.lng,
        status: ShiftStatus.OPEN,
      },
      select: SHIFT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "SHIFT_OPEN",
      entity: "Shift",
      entityId: shift.id,
      after: { attendantId: attendant.id, zoneId: shift.zoneId, startAt: shift.startAt },
      ...ctx,
    });

    return { ...shift, alreadyOpen: false };
  }

  /**
   * Closes the shift against a declared cash figure.
   *
   * The variance is `deposited - expected`. Negative means short — the common
   * and serious case. Positive means over, which is equally worth flagging: it
   * usually means a session was never recorded.
   */
  async close(id: string, dto: CloseShiftDto, user: AuthenticatedUser, ctx: Ctx) {
    const shift = await this.prisma.shift.findUnique({ where: { id }, select: SHIFT_SELECT });
    if (!shift) throw AppException.notFound("shift");

    if (shift.status !== ShiftStatus.OPEN) {
      throw new AppException(
        "SHIFT_ALREADY_CLOSED",
        [{ field: "status", issue: `shift is ${shift.status}` }],
        "This shift has already been closed.",
      );
    }

    if (user.attendantId && shift.attendantId !== user.attendantId) {
      throw AppException.forbidden("You can only close your own shift.");
    }

    // A session still running has a fare nobody has collected yet. Closing over
    // it would strand that money outside any shift.
    const openSessions = await this.prisma.parkingSession.count({
      where: { shiftId: id, status: { in: ["ACTIVE", "OVERSTAY"] } },
    });
    if (openSessions > 0) {
      throw new AppException(
        "SESSION_ALREADY_ACTIVE",
        [{ field: "shiftId", issue: `${openSessions} session(s) still running` }],
        `End all ${openSessions} running session(s) before closing the shift — their fares belong to it.`,
      );
    }

    const totals = await this.collected(id);
    const variance = dto.cashDeposited - totals.cash;

    const closed = await this.prisma.shift.update({
      where: { id },
      data: {
        status: variance === 0 ? ShiftStatus.CLOSED : ShiftStatus.VARIANCE_FLAGGED,
        endAt: new Date(),
        endLat: dto.location?.lat,
        endLng: dto.location?.lng,
        cashExpected: totals.cash,
        cashDeposited: dto.cashDeposited,
        digitalTotal: totals.digital,
        sessionsCount: totals.sessions,
        varianceAmount: variance,
      },
      select: SHIFT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: variance === 0 ? "SHIFT_CLOSE" : "SHIFT_CLOSE_VARIANCE",
      entity: "Shift",
      entityId: id,
      before: { status: shift.status },
      after: {
        cashExpected: totals.cash,
        cashDeposited: dto.cashDeposited,
        varianceAmount: variance,
        digitalTotal: totals.digital,
        notes: dto.notes,
      },
      ...ctx,
    });

    return {
      ...closed,
      // Said plainly, because the attendant sees this on a handset and needs to
      // know whether to go and look for the difference now.
      variance: {
        amount: variance,
        short: variance < 0,
        over: variance > 0,
        matched: variance === 0,
      },
    };
  }

  /**
   * A supervisor confirming they received the cash.
   *
   * Separate from closing on purpose: the attendant declares, someone else
   * confirms. One person doing both is how cash goes missing.
   */
  async verify(id: string, dto: VerifyShiftDto, user: AuthenticatedUser, ctx: Ctx) {
    const shift = await this.prisma.shift.findUnique({ where: { id }, select: SHIFT_SELECT });
    if (!shift) throw AppException.notFound("shift");

    if (shift.status === ShiftStatus.OPEN) {
      throw new AppException(
        "SHIFT_ALREADY_OPEN",
        [{ field: "status", issue: "shift has not been closed" }],
        "The attendant has not closed this shift yet.",
      );
    }
    if (shift.status === ShiftStatus.VERIFIED) {
      return shift;
    }
    if (user.attendantId && shift.attendantId === user.attendantId) {
      throw AppException.forbidden(
        "You cannot verify your own shift. Someone else must confirm they received the cash.",
      );
    }

    const received = dto.cashReceived ?? shift.cashDeposited ?? 0;
    const variance = received - shift.cashExpected;

    const verified = await this.prisma.shift.update({
      where: { id },
      data: {
        status: ShiftStatus.VERIFIED,
        cashDeposited: received,
        varianceAmount: variance,
        verifiedBy: user.id,
        verifiedAt: new Date(),
      },
      select: SHIFT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "SHIFT_VERIFY",
      entity: "Shift",
      entityId: id,
      before: { cashDeposited: shift.cashDeposited, varianceAmount: shift.varianceAmount },
      after: { cashReceived: received, varianceAmount: variance, notes: dto.notes },
      ...ctx,
    });

    return verified;
  }

  /** The attendant's own open shift, or null. What the app asks for on launch. */
  async current(user: AuthenticatedUser) {
    if (!user.attendantId) return null;

    const shift = await this.prisma.shift.findFirst({
      where: { attendantId: user.attendantId, status: ShiftStatus.OPEN },
      select: SHIFT_SELECT,
    });
    if (!shift) return null;

    const totals = await this.collected(shift.id);
    return {
      ...shift,
      // Live figures rather than the stored counters, so the handset shows what
      // the attendant will actually be asked to hand in.
      cashExpected: totals.cash,
      digitalTotal: totals.digital,
      sessionsCount: totals.sessions,
    };
  }

  async list(query: ShiftQueryDto, user: AuthenticatedUser) {
    const where = scoped<Prisma.ShiftWhereInput>(this.scopeFilter(user), {
      ...(query.status ? { status: query.status } : {}),
      ...(query.attendantId ? { attendantId: query.attendantId } : {}),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.zoneId ? { zoneId: query.zoneId } : {}),
      ...(query.varianceOnly ? { varianceAmount: { not: 0 } } : {}),
      ...(query.from || query.to
        ? { startAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    });

    const [items, total] = await this.prisma.$transaction([
      this.prisma.shift.findMany({
        where,
        select: SHIFT_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { startAt: "desc" }),
        ...skipTake(query),
      }),
      this.prisma.shift.count({ where }),
    ]);

    return new Paginated(items, query.page, query.pageSize, total);
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const shift = await this.prisma.shift.findFirst({
      where: scoped<Prisma.ShiftWhereInput>(this.scopeFilter(user), { id }),
      select: SHIFT_SELECT,
    });
    if (!shift) throw AppException.notFound("shift");

    const totals = await this.collected(id);
    return { ...shift, live: totals };
  }
}
