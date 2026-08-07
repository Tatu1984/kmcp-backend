import { z } from "zod";
import { ShiftStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

const Coordinate = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const OpenShiftSchema = z.object({
  zoneId: z.string().optional(),
  location: Coordinate.optional(),
  /** Makes an offline replay resolve to the one shift the attendant opened. */
  clientEventId: z.string().trim().min(8).max(64).optional(),
});
export type OpenShiftDto = z.infer<typeof OpenShiftSchema>;

export const CloseShiftSchema = z.object({
  /**
   * What the attendant says they are handing in, in paise.
   *
   * Deliberately required and deliberately not defaulted to the expected
   * figure: the whole point of a shift close is comparing what was counted
   * against what the system thinks was taken. Pre-filling it would turn a
   * count into a confirmation.
   */
  cashDeposited: z.number().int().min(0),
  location: Coordinate.optional(),
  notes: z.string().trim().max(500).optional(),
});
export type CloseShiftDto = z.infer<typeof CloseShiftSchema>;

export const VerifyShiftSchema = z.object({
  /** What the counting officer actually received, if it differs again. */
  cashReceived: z.number().int().min(0).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type VerifyShiftDto = z.infer<typeof VerifyShiftSchema>;

export const ShiftQuerySchema = PaginationSchema.extend({
  status: z.nativeEnum(ShiftStatus).optional(),
  attendantId: z.string().optional(),
  vendorId: z.string().optional(),
  zoneId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Only shifts where the count did not match. */
  varianceOnly: z.coerce.boolean().optional(),
});
export type ShiftQueryDto = z.infer<typeof ShiftQuerySchema>;
