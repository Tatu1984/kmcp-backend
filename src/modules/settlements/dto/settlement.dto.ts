import { z } from "zod";
import { SettlementStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

export const GenerateSettlementSchema = z
  .object({
    vendorId: z.string().min(1),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
  })
  .refine((dto) => dto.periodEnd > dto.periodStart, {
    message: "The period must end after it starts",
    path: ["periodEnd"],
  });
export type GenerateSettlementDto = z.infer<typeof GenerateSettlementSchema>;

export const RejectSettlementSchema = z.object({
  reason: z.string().trim().min(10, "Say what is wrong with it").max(1000),
});
export type RejectSettlementDto = z.infer<typeof RejectSettlementSchema>;

export const PayoutSettlementSchema = z.object({
  /**
   * The bank's reference for the transfer — a NEFT/RTGS UTR, or a RazorpayX
   * payout id once those credentials exist.
   *
   * Required because a settlement marked paid with nothing to trace it to is
   * worse than one left unpaid: the money is now unaccounted for on both sides.
   */
  reference: z.string().trim().min(4, "A payout needs its bank reference").max(120),
  note: z.string().trim().max(500).optional(),
});
export type PayoutSettlementDto = z.infer<typeof PayoutSettlementSchema>;

export const SettlementQuerySchema = PaginationSchema.extend({
  status: z.nativeEnum(SettlementStatus).optional(),
  vendorId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type SettlementQueryDto = z.infer<typeof SettlementQuerySchema>;

export const RevenueQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  vendorId: z.string().optional(),
});
export type RevenueQueryDto = z.infer<typeof RevenueQuerySchema>;
