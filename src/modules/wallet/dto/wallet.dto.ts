import { z } from "zod";
import { PaginationSchema } from "@/common/dto/pagination.dto";

export const TopUpSchema = z.object({
  /**
   * ₹50,000 in paise — a sanity ceiling against a fat-fingered or abusive
   * top-up, not a real business limit. Nothing downstream depends on this
   * figure; it exists purely so a stray extra zero does not create a gateway
   * order for lakhs of rupees.
   */
  amount: z.number().int().positive().max(50_000_00),
});
export type TopUpDto = z.infer<typeof TopUpSchema>;

export const WalletEntriesQuerySchema = PaginationSchema;
export type WalletEntriesQueryDto = z.infer<typeof WalletEntriesQuerySchema>;

export const PayFromWalletSchema = z.object({
  sessionId: z.string().min(1),
  /**
   * The caller's own key for this payment. Required for money — a citizen
   * tapping "pay" twice on a slow connection must produce one payment, same
   * convention as `CollectPaymentSchema.idempotencyKey`.
   */
  idempotencyKey: z.string().trim().min(8).max(64),
});
export type PayFromWalletDto = z.infer<typeof PayFromWalletSchema>;
