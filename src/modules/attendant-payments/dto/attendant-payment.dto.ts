import { z } from "zod";
import { AttendantPayMode } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

/**
 * Recording a payment a vendor has already made to one of their attendants.
 *
 * This records money that moved; it does not move it. A vendor pays their staff
 * by cash in hand, by UPI from their own account, or by bank transfer, and the
 * platform's job is to hold the evidence that it happened — not to become a
 * payroll processor for money that never touches KMC.
 */
export const CreateAttendantPaymentSchema = z
  .object({
    attendantId: z.string().min(1, "Say who was paid"),
    /** Paise, like every other amount on the wire. */
    amount: z
      .number()
      .int("Amounts are in paise, so whole numbers only")
      .positive("A payment has to be more than nothing")
      .max(10_000_000, "That is more than ₹1,00,000 — check the amount"),
    mode: z.nativeEnum(AttendantPayMode),
    periodStart: z.coerce.date().optional(),
    periodEnd: z.coerce.date().optional(),
    /**
     * Whatever proves it moved: a UPI transaction id, a bank UTR, or the number
     * on a cash voucher the attendant signed.
     */
    reference: z.string().trim().max(120).optional(),
    note: z.string().trim().max(500).optional(),
    /** Defaults to now. Backdating is allowed — vendors record in arrears. */
    paidAt: z.coerce.date().optional(),
  })
  .refine((v) => !v.periodStart || !v.periodEnd || v.periodEnd >= v.periodStart, {
    message: "The period ends before it starts",
    path: ["periodEnd"],
  })
  .refine((v) => v.mode === AttendantPayMode.CASH || Boolean(v.reference), {
    // Cash has nothing to quote. Anything electronic does, and a transfer with
    // no reference cannot be reconciled against a bank statement later, which
    // is the only reason to record it at all.
    message: "A UPI or bank payment needs its transaction reference",
    path: ["reference"],
  });
export type CreateAttendantPaymentDto = z.infer<typeof CreateAttendantPaymentSchema>;

export const AttendantPaymentQuerySchema = PaginationSchema.extend({
  attendantId: z.string().optional(),
  mode: z.nativeEnum(AttendantPayMode).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type AttendantPaymentQueryDto = z.infer<typeof AttendantPaymentQuerySchema>;
