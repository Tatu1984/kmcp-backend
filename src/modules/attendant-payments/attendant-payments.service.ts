import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type {
  AttendantPaymentQueryDto,
  CreateAttendantPaymentDto,
} from "./dto/attendant-payment.dto";

type Ctx = { ip?: string; requestId?: string };

const SORTABLE = ["paidAt", "amount", "createdAt"] as const;

const PAYMENT_SELECT = {
  id: true,
  vendorId: true,
  attendantId: true,
  amount: true,
  mode: true,
  periodStart: true,
  periodEnd: true,
  reference: true,
  note: true,
  paidAt: true,
  recordedById: true,
  createdAt: true,
  attendant: {
    select: {
      id: true,
      employeeCode: true,
      user: { select: { name: true, phone: true } },
    },
  },
} satisfies Prisma.AttendantPaymentSelect;

/**
 * What a vendor paid their own staff.
 *
 * KMC contracts the vendor, the vendor employs the attendant, and this is the
 * second leg of that chain — the one that used to live in a notebook belonging
 * to whoever owed the money.
 *
 * ── The privacy boundary, and why a permission alone is not one ──
 *
 * These records are the vendor's business and nobody else's. That is a stated
 * requirement, and it cannot be met with a permission grant, because
 * `RolesService.can` returns true for any superuser before it looks at the
 * permission list at all. A `attendant.pay.read` grant would therefore keep out
 * an auditor and let in a SUPER_ADMIN, which is precisely backwards.
 *
 * So the boundary here is structural rather than permissive: every method
 * begins by demanding a `vendorId` on the caller and filters by it. An account
 * without one — every KMC role, superuser included — is refused, because there
 * is no vendor whose staff payments it could be asking about. The permission
 * still gates the route; the `vendorId` is what makes the answer private.
 */
@Injectable()
export class AttendantPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The only way into this table.
   *
   * Returns the caller's own vendor id or refuses. There is deliberately no
   * branch that widens for a privileged role, and none should be added: the
   * moment one exists, "only the vendor sees this" stops being true and the
   * table quietly becomes a city-wide wage register.
   */
  private vendorOf(user: AuthenticatedUser): string {
    if (!user.vendorId) {
      throw AppException.forbidden(
        "Staff payments belong to the vendor who made them. This account is not a vendor.",
      );
    }
    return user.vendorId;
  }

  /** Confirms the attendant is on this vendor's own payroll before touching them. */
  private async assertOwnStaff(attendantId: string, vendorId: string) {
    const attendant = await this.prisma.attendant.findFirst({
      where: { id: attendantId, vendorId },
      select: { id: true, employeeCode: true },
    });
    if (!attendant) {
      // Deliberately the same answer whether the attendant belongs to another
      // vendor or does not exist. Distinguishing the two would let one vendor
      // probe another's staff list one id at a time.
      throw AppException.notFound("attendant");
    }
    return attendant;
  }

  async list(query: AttendantPaymentQueryDto, user: AuthenticatedUser) {
    const vendorId = this.vendorOf(user);

    const where: Prisma.AttendantPaymentWhereInput = {
      // Not spread from the query — the vendor scope is the first and last word
      // on which rows exist, so a caller cannot widen it with a parameter.
      vendorId,
      ...(query.attendantId ? { attendantId: query.attendantId } : {}),
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.from || query.to
        ? {
            paidAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendantPayment.findMany({
        where,
        select: PAYMENT_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { paidAt: "desc" }),
        ...skipTake(query),
      }),
      this.prisma.attendantPayment.count({ where }),
    ]);

    return new Paginated(rows, query.page, query.pageSize, total);
  }

  /**
   * What this vendor has paid out, and to whom.
   *
   * Grouped per attendant rather than returned as a single figure, because the
   * question a vendor actually has at the end of a month is "who is still
   * owed", and that is answered by names, not by a total.
   */
  async summary(query: AttendantPaymentQueryDto, user: AuthenticatedUser) {
    const vendorId = this.vendorOf(user);

    const where: Prisma.AttendantPaymentWhereInput = {
      vendorId,
      ...(query.from || query.to
        ? {
            paidAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [byMode, byAttendant, totals, staff] = await Promise.all([
      this.prisma.attendantPayment.groupBy({
        by: ["mode"],
        where,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.attendantPayment.groupBy({
        by: ["attendantId"],
        where,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.attendantPayment.aggregate({
        where,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.attendant.findMany({
        where: { vendorId },
        select: { id: true, employeeCode: true, isActive: true, user: { select: { name: true } } },
      }),
    ]);

    const paid = new Map(byAttendant.map((r) => [r.attendantId, r]));

    return {
      totalPaid: totals._sum.amount ?? 0,
      payments: totals._count._all,
      byMode: byMode.map((m) => ({
        mode: m.mode,
        amount: m._sum.amount ?? 0,
        count: m._count._all,
      })),
      // Every attendant on the books, including those paid nothing in the
      // period — a name missing from this list would read as "nothing owed"
      // when it actually means "never paid".
      byAttendant: staff.map((s) => ({
        attendantId: s.id,
        name: s.user.name,
        employeeCode: s.employeeCode,
        isActive: s.isActive,
        amount: paid.get(s.id)?._sum.amount ?? 0,
        payments: paid.get(s.id)?._count._all ?? 0,
      })),
    };
  }

  async create(dto: CreateAttendantPaymentDto, user: AuthenticatedUser, ctx: Ctx) {
    const vendorId = this.vendorOf(user);
    const attendant = await this.assertOwnStaff(dto.attendantId, vendorId);

    const payment = await this.prisma.attendantPayment.create({
      data: {
        vendorId,
        attendantId: dto.attendantId,
        amount: dto.amount,
        mode: dto.mode,
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        reference: dto.reference,
        note: dto.note,
        paidAt: dto.paidAt ?? new Date(),
        recordedById: user.id,
      },
      select: PAYMENT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "ATTENDANT_PAYMENT_RECORD",
      entity: "AttendantPayment",
      entityId: payment.id,
      after: {
        attendant: attendant.employeeCode,
        amount: dto.amount,
        mode: dto.mode,
        reference: dto.reference,
      },
      ...ctx,
    });

    return payment;
  }

  /**
   * Deleting is not offered.
   *
   * A payment record that can be removed is not evidence that anybody was paid.
   * A vendor who recorded the wrong figure records a correcting entry against
   * the same attendant, and both rows stand — the same reasoning that keeps a
   * refund a separate payment rather than an edit to the original.
   */
}
