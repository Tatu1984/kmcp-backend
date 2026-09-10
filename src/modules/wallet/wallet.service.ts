import { Injectable, Logger } from "@nestjs/common";
import { PaymentMode, PaymentStatus, WalletEntryKind } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { PaymentsService } from "@/modules/payments/payments.service";
import { RazorpayService } from "@/modules/payments/razorpay.service";
import type { PayFromWalletDto, TopUpDto, WalletEntriesQueryDto } from "./dto/wallet.dto";

type Ctx = { ip?: string; requestId?: string };

/** `Payment.status` values a client-facing `WalletTopUp.status` can hold. */
const TOPUP_STATUS: Record<PaymentStatus, "PENDING" | "CAPTURED" | "FAILED"> = {
  [PaymentStatus.PENDING]: "PENDING",
  [PaymentStatus.CAPTURED]: "CAPTURED",
  [PaymentStatus.FAILED]: "FAILED",
  // A top-up payment is never refunded — refunding a wallet credit is a
  // wallet-ledger reversal, not a gateway refund — but the map must be total
  // over `PaymentStatus` to type-check, so these fall back to the closest
  // honest answer for a caller polling this order.
  [PaymentStatus.REFUNDED]: "FAILED",
  [PaymentStatus.PARTIALLY_REFUNDED]: "CAPTURED",
};

const WALLET_ENTRY_SELECT = {
  id: true,
  kind: true,
  amount: true,
  balanceAfter: true,
  description: true,
  sessionId: true,
  zone: { select: { id: true, name: true } },
  createdAt: true,
} as const;

/**
 * A citizen's wallet: a derived balance, a read-only ledger, topping up
 * through Razorpay, and paying for a parking session straight out of it.
 *
 * The balance is never a stored number — it is always the sum of
 * `WalletEntry.amount` for the user, recomputed on every read, the same
 * reasoning `PaymentsService.outstanding` already leans on for a session's
 * fare. That is what makes a balance disputed months later answerable: the
 * ledger is the only thing that ever had to be right.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly razorpay: RazorpayService,
    private readonly paymentsService: PaymentsService,
  ) {}

  private async currentBalance(userId: string): Promise<number> {
    const agg = await this.prisma.walletEntry.aggregate({
      where: { userId },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  async balance(user: AuthenticatedUser) {
    const [balance, latest] = await Promise.all([
      this.currentBalance(user.id),
      this.prisma.walletEntry.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    return { balance, currency: "INR" as const, updatedAt: latest?.createdAt ?? null };
  }

  async entries(query: WalletEntriesQueryDto, user: AuthenticatedUser) {
    const where = { userId: user.id };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.walletEntry.findMany({
        where,
        select: WALLET_ENTRY_SELECT,
        orderBy: { createdAt: "desc" },
        ...skipTake(query),
      }),
      this.prisma.walletEntry.count({ where }),
    ]);

    return new Paginated(items, query.page, query.pageSize, total);
  }

  /**
   * Starts a top-up: a Razorpay order plus a `PENDING` `Payment` marked as
   * this user's wallet top-up. The credit itself is written by
   * `PaymentsService.handleWebhook` once the gateway confirms the capture —
   * nothing here touches `WalletEntry`.
   */
  async topUp(dto: TopUpDto, user: AuthenticatedUser, ctx: Ctx) {
    const order = await this.razorpay.createOrder(dto.amount, `wallet-${user.id}-${Date.now()}`, {
      userId: user.id,
      purpose: "wallet_topup",
    });

    const payment = await this.prisma.payment.create({
      data: {
        sessionId: null,
        mode: PaymentMode.UPI_INTENT,
        amount: dto.amount,
        status: PaymentStatus.PENDING,
        // The client never sends one for a top-up (there is no session or
        // collection attempt to key it to); the gateway order id is already
        // unique per order, so it doubles as a stable idempotency key.
        idempotencyKey: `wallet-topup-${order.id}`,
        gateway: "razorpay",
        gatewayOrderId: order.id,
        walletTopUpUserId: user.id,
      },
    });

    await this.audit.record({
      actor: user,
      action: "WALLET_TOPUP_ORDER_CREATE",
      entity: "Payment",
      entityId: payment.id,
      after: { amount: dto.amount, orderId: order.id },
      ...ctx,
    });

    return {
      id: payment.id,
      amount: payment.amount,
      status: TOPUP_STATUS[payment.status],
      gatewayKeyId: this.razorpay.keyId,
      gatewayOrder: { id: order.id, amount: order.amount, currency: order.currency },
    };
  }

  /**
   * Pays for a parking session straight out of the wallet balance — no
   * gateway, no checkout, settled the instant the balance covers it.
   */
  async payFromWallet(dto: PayFromWalletDto, user: AuthenticatedUser, ctx: Ctx) {
    const replay = await this.prisma.payment.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (replay) return { ...replay, replayed: true };

    const { session, owed } = await this.paymentsService.outstanding(dto.sessionId);

    if (session.vehicle.ownerUserId !== user.id) {
      throw AppException.forbidden("You can only pay for your own parking.");
    }

    if (owed === 0) {
      throw new AppException(
        "DUPLICATE_RESOURCE",
        [{ field: "sessionId", issue: "already paid in full" }],
        `${session.code} has already been paid. Nothing further is owed.`,
      );
    }

    const balance = await this.currentBalance(user.id);
    if (balance < owed) throw new AppException("INSUFFICIENT_BALANCE");

    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          sessionId: session.id,
          shiftId: session.shiftId,
          mode: PaymentMode.WALLET,
          amount: owed,
          status: PaymentStatus.CAPTURED,
          idempotencyKey: dto.idempotencyKey,
          paidByUserId: user.id,
          paidAt: new Date(),
        },
      });

      await tx.walletEntry.create({
        data: {
          userId: user.id,
          kind: WalletEntryKind.SESSION_DEBIT,
          amount: -owed,
          balanceAfter: balance - owed,
          description: `Paid for ${session.code}`,
          sessionId: session.id,
          zoneId: null,
        },
      });

      return created;
    });

    const receipt = await this.paymentsService.issueReceipt(payment.id);

    await this.audit.record({
      actor: user,
      action: "WALLET_PAYMENT",
      entity: "Payment",
      entityId: payment.id,
      after: { sessionCode: session.code, amount: owed, mode: PaymentMode.WALLET },
      ...ctx,
    });

    return { ...payment, receipt, replayed: false };
  }
}
