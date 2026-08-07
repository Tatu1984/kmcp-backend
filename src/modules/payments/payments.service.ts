import { Injectable, Logger } from "@nestjs/common";
import { SYSTEM_ROLES, type RoleCode } from "@/common/rbac/permissions";
import { PaymentMode, PaymentStatus, Prisma, SessionStatus } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import { financialYear, generateReceiptNumber } from "@/common/utils/plate.util";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { RazorpayService } from "./razorpay.service";
import type {
  CollectPaymentDto,
  PaymentQueryDto,
  RefundPaymentDto,
  VerifyPaymentDto,
} from "./dto/payment.dto";

type Ctx = { ip?: string; requestId?: string };

const SORTABLE = ["createdAt", "amount", "status", "paidAt"] as const;

const PAYMENT_SELECT = {
  id: true,
  sessionId: true,
  passId: true,
  shiftId: true,
  mode: true,
  amount: true,
  status: true,
  idempotencyKey: true,
  gateway: true,
  gatewayOrderId: true,
  gatewayPaymentId: true,
  signatureVerified: true,
  collectedByAttendantId: true,
  paidByUserId: true,
  paidAt: true,
  refundedAmount: true,
  failureReason: true,
  createdAt: true,
  session: {
    select: { id: true, code: true, plateNumber: true, zoneId: true, vendorId: true, payableAmount: true },
  },
  receipt: { select: { id: true, number: true, gstInvoiceNo: true, issuedAt: true, sentChannels: true } },
} satisfies Prisma.PaymentSelect;

const GATEWAY_MODES: PaymentMode[] = [
  PaymentMode.UPI_QR,
  PaymentMode.UPI_INTENT,
  PaymentMode.CARD,
  PaymentMode.NETBANKING,
  PaymentMode.WALLET,
];

/**
 * Collecting, confirming and refunding money.
 *
 * Two rules run through all of it. The amount always comes from the session's
 * computed fare, never from the caller — otherwise a modified client could name
 * its own price. And every write is idempotent on a key, because the network
 * between a handset at a kerb and this API drops constantly, and a retry must
 * never become a second charge.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly razorpay: RazorpayService,
  ) {}

  private scopeFilter(user: AuthenticatedUser): Prisma.PaymentWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) {
      return { session: { vendorId: user.vendorId } };
    }
    if (user.isZoneScoped && user.zoneIds.length > 0) {
      return { session: { zoneId: { in: user.zoneIds } } };
    }
    return {};
  }

  /**
   * What is still owed on a session.
   *
   * Anything already captured counts against it, so a part payment in cash
   * followed by the rest on UPI settles correctly, and a second full payment
   * for the same session is refused rather than silently taken.
   */
  private async outstanding(sessionId: string): Promise<{
    session: { id: string; code: string; status: SessionStatus; payableAmount: number | null; shiftId: string | null; attendantId: string | null };
    owed: number;
    captured: number;
  }> {
    const session = await this.prisma.parkingSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        code: true,
        status: true,
        payableAmount: true,
        shiftId: true,
        attendantId: true,
      },
    });
    if (!session) throw AppException.notFound("session");

    if (session.payableAmount === null) {
      throw new AppException(
        "SESSION_NOT_ACTIVE",
        [{ field: "sessionId", issue: "the session has no fare yet" }],
        "End the parking session first — there is nothing to pay until it has been priced.",
      );
    }
    if (session.status === SessionStatus.CANCELLED) {
      throw new AppException(
        "SESSION_NOT_ACTIVE",
        [{ field: "sessionId", issue: "session was cancelled" }],
        "A cancelled session carries no charge.",
      );
    }

    const agg = await this.prisma.payment.aggregate({
      where: { sessionId, status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] } },
      _sum: { amount: true, refundedAmount: true },
    });

    const captured = (agg._sum.amount ?? 0) - (agg._sum.refundedAmount ?? 0);
    return { session, owed: Math.max(0, session.payableAmount - captured), captured };
  }

  /**
   * Starts a collection.
   *
   * Cash is captured immediately — the attendant already has the notes in hand,
   * and the record has to reflect that before the handset goes offline again.
   * Everything else creates a gateway order and stays PENDING until Razorpay
   * confirms it, either through the client's signed callback or the webhook.
   */
  async collect(dto: CollectPaymentDto, user: AuthenticatedUser, ctx: Ctx) {
    const replay = await this.prisma.payment.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
      select: PAYMENT_SELECT,
    });
    if (replay) return { ...replay, replayed: true, gatewayKeyId: this.razorpay.keyId };

    const { session, owed } = await this.outstanding(dto.sessionId);

    if (owed === 0) {
      throw new AppException(
        "DUPLICATE_RESOURCE",
        [{ field: "sessionId", issue: "already paid in full" }],
        `${session.code} has already been paid. Nothing further is owed.`,
      );
    }

    if (dto.mode === PaymentMode.CASH) {
      const payment = await this.prisma.payment.create({
        data: {
          sessionId: session.id,
          shiftId: session.shiftId,
          mode: PaymentMode.CASH,
          amount: owed,
          status: PaymentStatus.CAPTURED,
          idempotencyKey: dto.idempotencyKey,
          collectedByAttendantId: user.attendantId ?? session.attendantId,
          paidAt: new Date(),
        },
        select: PAYMENT_SELECT,
      });

      // Cash is what the attendant will be asked to deposit at shift close, so
      // the expected figure moves the moment it is collected.
      if (session.shiftId) {
        await this.prisma.shift.update({
          where: { id: session.shiftId },
          data: { cashExpected: { increment: owed } },
        });
      }

      const receipt = await this.issueReceipt(payment.id);

      await this.audit.record({
        actor: user,
        action: "PAYMENT_COLLECT_CASH",
        entity: "Payment",
        entityId: payment.id,
        after: { sessionCode: session.code, amount: owed, mode: PaymentMode.CASH },
        ...ctx,
      });

      return { ...payment, receipt, replayed: false };
    }

    if (!GATEWAY_MODES.includes(dto.mode)) {
      throw new AppException("VALIDATION_FAILED", [
        { field: "mode", issue: `${dto.mode} cannot be collected through this endpoint` },
      ]);
    }

    const order = await this.razorpay.createOrder(owed, session.code, {
      sessionCode: session.code,
      sessionId: session.id,
    });

    const payment = await this.prisma.payment.create({
      data: {
        sessionId: session.id,
        shiftId: session.shiftId,
        mode: dto.mode,
        amount: owed,
        status: PaymentStatus.PENDING,
        idempotencyKey: dto.idempotencyKey,
        gateway: "razorpay",
        gatewayOrderId: order.id,
        collectedByAttendantId: user.attendantId ?? session.attendantId,
        paidByUserId: dto.paidByUserId,
      },
      select: PAYMENT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "PAYMENT_ORDER_CREATE",
      entity: "Payment",
      entityId: payment.id,
      after: { sessionCode: session.code, amount: owed, mode: dto.mode, orderId: order.id },
      ...ctx,
    });

    return {
      ...payment,
      replayed: false,
      // What a checkout sheet needs. The key id is publishable by design.
      gatewayKeyId: this.razorpay.keyId,
      gatewayOrder: { id: order.id, amount: order.amount, currency: order.currency },
    };
  }

  /**
   * Confirms a checkout the client says succeeded.
   *
   * The signature is the whole point: it is computed with a secret the client
   * has never held, so a forged "I paid" cannot capture a payment. The webhook
   * remains the authority — this exists so the citizen sees a receipt without
   * waiting for it.
   */
  async verify(id: string, dto: VerifyPaymentDto, user: AuthenticatedUser, ctx: Ctx) {
    const payment = await this.prisma.payment.findUnique({ where: { id }, select: PAYMENT_SELECT });
    if (!payment) throw AppException.notFound("payment");

    if (payment.status === PaymentStatus.CAPTURED) {
      return { ...payment, replayed: true };
    }
    if (payment.gatewayOrderId !== dto.razorpayOrderId) {
      throw new AppException("PAYMENT_SIGNATURE_INVALID", [
        { field: "razorpayOrderId", issue: "does not belong to this payment" },
      ]);
    }

    const valid = this.razorpay.verifyCheckoutSignature(
      dto.razorpayOrderId,
      dto.razorpayPaymentId,
      dto.razorpaySignature,
    );
    if (!valid) {
      await this.prisma.payment.update({
        where: { id },
        data: { failureReason: "Checkout signature did not verify" },
      });
      await this.audit.record({
        actor: user,
        action: "PAYMENT_SIGNATURE_REJECTED",
        entity: "Payment",
        entityId: id,
        after: { razorpayPaymentId: dto.razorpayPaymentId },
        ...ctx,
      });
      throw new AppException("PAYMENT_SIGNATURE_INVALID");
    }

    const captured = await this.capture(id, dto.razorpayPaymentId, true);

    await this.audit.record({
      actor: user,
      action: "PAYMENT_CAPTURED",
      entity: "Payment",
      entityId: id,
      after: { amount: captured.amount, via: "checkout" },
      ...ctx,
    });

    return { ...captured, replayed: false };
  }

  /**
   * Marks a payment captured and issues its receipt.
   *
   * Written so that calling it twice is harmless: the webhook and the client
   * callback race constantly, and both must be able to arrive.
   */
  private async capture(id: string, gatewayPaymentId: string, signatureVerified: boolean) {
    const existing = await this.prisma.payment.findUnique({ where: { id }, select: { status: true } });
    if (existing?.status === PaymentStatus.CAPTURED) {
      const already = await this.prisma.payment.findUnique({ where: { id }, select: PAYMENT_SELECT });
      return already!;
    }

    const payment = await this.prisma.payment.update({
      where: { id },
      data: {
        status: PaymentStatus.CAPTURED,
        gatewayPaymentId,
        signatureVerified,
        paidAt: new Date(),
        failureReason: null,
      },
      select: PAYMENT_SELECT,
    });

    await this.issueReceipt(payment.id);
    return this.prisma.payment.findUnique({ where: { id }, select: PAYMENT_SELECT }) as Promise<
      typeof payment
    >;
  }

  /**
   * Razorpay's own account of what happened, and the one this system trusts.
   *
   * Every branch is idempotent because Razorpay retries a webhook until it gets
   * a 2xx, and will happily deliver the same event several times.
   */
  async handleWebhook(rawBody: Buffer | string, signature: string, event: Record<string, unknown>) {
    if (!this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      // Deliberately not a 4xx with detail: an unsigned caller learns nothing.
      this.logger.warn("Rejected a webhook with an invalid signature");
      throw new AppException("PAYMENT_SIGNATURE_INVALID");
    }

    const type = String(event.event ?? "");
    const entity = (
      (event.payload as Record<string, Record<string, Record<string, unknown>>> | undefined)?.payment
        ?.entity ?? {}
    ) as Record<string, unknown>;

    const orderId = entity.order_id as string | undefined;
    const paymentId = entity.id as string | undefined;
    if (!orderId || !paymentId) return { handled: false, reason: "no payment entity on the event" };

    const payment = await this.prisma.payment.findFirst({
      where: { gatewayOrderId: orderId },
      select: { id: true, status: true, amount: true },
    });
    if (!payment) {
      // Not an error: the account may be shared, and events for other systems
      // are none of our business. Acknowledge so Razorpay stops retrying.
      this.logger.warn(`Webhook for unknown order ${orderId} — acknowledged and ignored`);
      return { handled: false, reason: "order not recognised" };
    }

    if (type === "payment.captured") {
      const paidAmount = Number(entity.amount ?? 0);
      if (paidAmount !== payment.amount) {
        // Never silently accept a different figure. Someone paying ₹1 against a
        // ₹65 order is the exact fraud this check exists for.
        this.logger.error(
          `Webhook amount ${paidAmount} does not match payment ${payment.id} amount ${payment.amount}`,
        );
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { failureReason: `Gateway reported ${paidAmount} against an order of ${payment.amount}` },
        });
        return { handled: false, reason: "amount mismatch" };
      }

      await this.capture(payment.id, paymentId, true);
      await this.audit.record({
        actor: null,
        action: "PAYMENT_CAPTURED",
        entity: "Payment",
        entityId: payment.id,
        after: { amount: paidAmount, via: "webhook" },
      });
      return { handled: true, event: type, paymentId: payment.id };
    }

    if (type === "payment.failed") {
      if (payment.status !== PaymentStatus.CAPTURED) {
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.FAILED,
            gatewayPaymentId: paymentId,
            failureReason: String(entity.error_description ?? "Declined by the gateway"),
          },
        });
      }
      return { handled: true, event: type, paymentId: payment.id };
    }

    return { handled: false, reason: `unhandled event ${type}` };
  }

  /**
   * Refunds up to what is still refundable.
   *
   * Cash cannot be refunded through the gateway — the money never went through
   * it. Those are recorded here and settled at the counter, which is why the
   * reason is mandatory.
   */
  async refund(id: string, dto: RefundPaymentDto, user: AuthenticatedUser, ctx: Ctx) {
    const payment = await this.prisma.payment.findUnique({ where: { id }, select: PAYMENT_SELECT });
    if (!payment) throw AppException.notFound("payment");

    if (payment.status !== PaymentStatus.CAPTURED && payment.status !== PaymentStatus.PARTIALLY_REFUNDED) {
      throw new AppException(
        "PAYMENT_NOT_CONFIRMED",
        [{ field: "status", issue: `payment is ${payment.status}` }],
        "Only a captured payment can be refunded.",
      );
    }

    const refundable = payment.amount - payment.refundedAmount;
    const amount = dto.amount ?? refundable;

    if (amount > refundable) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "amount", issue: `at most ${refundable} paise can still be refunded` }],
        "That is more than remains on this payment.",
      );
    }

    if (payment.mode !== PaymentMode.CASH) {
      if (!payment.gatewayPaymentId) {
        throw new AppException("PAYMENT_NOT_CONFIRMED", [
          { field: "gatewayPaymentId", issue: "no gateway payment recorded" },
        ]);
      }
      await this.razorpay.refund(payment.gatewayPaymentId, amount, { reason: dto.reason });
    }

    const refundedAmount = payment.refundedAmount + amount;
    const updated = await this.prisma.payment.update({
      where: { id },
      data: {
        refundedAmount,
        status:
          refundedAmount >= payment.amount ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
      },
      select: PAYMENT_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: payment.mode === PaymentMode.CASH ? "PAYMENT_REFUND_CASH" : "PAYMENT_REFUND",
      entity: "Payment",
      entityId: id,
      before: { refundedAmount: payment.refundedAmount, status: payment.status },
      after: { refundedAmount, status: updated.status, amount, reason: dto.reason },
      ...ctx,
    });

    return updated;
  }

  /**
   * Issues the receipt for a captured payment.
   *
   * Numbered sequentially within the Indian financial year, which is what the
   * authority's accounts and any GST filing expect. Never reissued: a receipt
   * number that appears twice is an audit finding.
   */
  async issueReceipt(paymentId: string) {
    const existing = await this.prisma.receipt.findUnique({ where: { paymentId } });
    if (existing) return existing;

    const now = new Date();
    const fy = financialYear(now);

    const prefixRow = await this.prisma.systemConfig.findUnique({ where: { key: "tax.invoicePrefix" } });
    const prefix = typeof prefixRow?.value === "string" ? prefixRow.value : "RCPT/";

    // Sequence within the financial year. Counting existing receipts is honest
    // but races under load; the unique constraint on `number` is what actually
    // guarantees it, and a collision simply retries.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const count = await this.prisma.receipt.count({
        where: { number: { startsWith: `${prefix}${fy}/` } },
      });
      const number = generateReceiptNumber(fy, count + 1 + attempt).replace(/^RCPT\//, prefix);

      try {
        return await this.prisma.receipt.create({ data: { paymentId, number } });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          attempt < 4
        ) {
          continue;
        }
        throw error;
      }
    }

    throw new AppException(
      "INTERNAL_ERROR",
      undefined,
      "Could not allocate a receipt number. The payment is recorded — please retry the receipt.",
    );
  }

  async list(query: PaymentQueryDto, user: AuthenticatedUser) {
    const where: Prisma.PaymentWhereInput = {
      ...this.scopeFilter(user),
      ...(query.status ? { status: query.status } : {}),
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.shiftId ? { shiftId: query.shiftId } : {}),
      ...(query.vendorId ? { session: { vendorId: query.vendorId } } : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { gatewayPaymentId: { contains: query.q, mode: "insensitive" } },
              { session: { code: { contains: query.q, mode: "insensitive" } } },
              { session: { plateNumber: { contains: query.q.toUpperCase() } } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        select: PAYMENT_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { createdAt: "desc" }),
        ...skipTake(query),
      }),
      this.prisma.payment.count({ where }),
    ]);

    return new Paginated(items, query.page, query.pageSize, total);
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const payment = await this.prisma.payment.findFirst({
      where: { id, ...this.scopeFilter(user) },
      select: PAYMENT_SELECT,
    });
    if (!payment) throw AppException.notFound("payment");
    return payment;
  }

  /** Collection totals for a day, split the way a reconciliation needs them. */
  async summary(user: AuthenticatedUser, from?: Date, to?: Date) {
    const where: Prisma.PaymentWhereInput = {
      ...this.scopeFilter(user),
      status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
      ...(from || to
        ? { paidAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    };

    const [byMode, totals] = await Promise.all([
      this.prisma.payment.groupBy({ by: ["mode"], where, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.payment.aggregate({ where, _sum: { amount: true, refundedAmount: true }, _count: { _all: true } }),
    ]);

    const cash = byMode.filter((m) => m.mode === PaymentMode.CASH);
    const digital = byMode.filter((m) => m.mode !== PaymentMode.CASH);
    const sum = (rows: typeof byMode) => rows.reduce((s, r) => s + (r._sum.amount ?? 0), 0);

    return {
      collected: totals._sum.amount ?? 0,
      refunded: totals._sum.refundedAmount ?? 0,
      net: (totals._sum.amount ?? 0) - (totals._sum.refundedAmount ?? 0),
      count: totals._count._all,
      // The split that matters: cash is money someone is physically holding
      // until they deposit it; digital has already reached a bank.
      cash: sum(cash),
      digital: sum(digital),
      byMode: byMode.map((m) => ({ mode: m.mode, amount: m._sum.amount ?? 0, count: m._count._all })),
    };
  }
}
