import { z } from "zod";
import { PaymentMode, PaymentStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

/**
 * Note what is absent from every schema here: an amount.
 *
 * What a session costs is decided by the fare engine from the tariff that was
 * live in that zone. A client that could name its own price would be able to
 * pay ₹1 for a day's parking, so it does not get to.
 */

export const CollectPaymentSchema = z.object({
  sessionId: z.string().min(1),
  mode: z.nativeEnum(PaymentMode),
  /**
   * The caller's own key for this collection. Required for money — an attendant
   * tapping "collect" twice on a slow connection must produce one payment.
   */
  idempotencyKey: z.string().trim().min(8).max(64),
  /** Set when a citizen is paying for their own session from the app. */
  paidByUserId: z.string().optional(),
});
export type CollectPaymentDto = z.infer<typeof CollectPaymentSchema>;

/** What the client hands back after Razorpay checkout completes. */
export const VerifyPaymentSchema = z.object({
  razorpayOrderId: z.string().trim().min(4),
  razorpayPaymentId: z.string().trim().min(4),
  razorpaySignature: z.string().trim().min(16),
});
export type VerifyPaymentDto = z.infer<typeof VerifyPaymentSchema>;

export const RefundPaymentSchema = z.object({
  /** Omitted means refund everything still refundable. */
  amount: z.number().int().positive().optional(),
  reason: z.string().trim().min(4, "A refund needs a reason").max(500),
});
export type RefundPaymentDto = z.infer<typeof RefundPaymentSchema>;

export const PaymentQuerySchema = PaginationSchema.extend({
  status: z.nativeEnum(PaymentStatus).optional(),
  mode: z.nativeEnum(PaymentMode).optional(),
  sessionId: z.string().optional(),
  shiftId: z.string().optional(),
  vendorId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type PaymentQueryDto = z.infer<typeof PaymentQuerySchema>;

export const SendReceiptSchema = z.object({
  channels: z.array(z.enum(["sms", "whatsapp", "email"])).min(1),
  to: z.string().trim().max(120).optional(),
});
export type SendReceiptDto = z.infer<typeof SendReceiptSchema>;
