import { z } from "zod";
import { SessionStatus, SlotType } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

export const AddVehicleSchema = z.object({
  plateNumber: z.string().trim().min(4).max(16),
  vehicleType: z.nativeEnum(SlotType),
});
export type AddVehicleDto = z.infer<typeof AddVehicleSchema>;

export const MySessionsQuerySchema = PaginationSchema.extend({
  status: z.nativeEnum(SessionStatus).optional(),
});
export type MySessionsQueryDto = z.infer<typeof MySessionsQuerySchema>;

/**
 * The code on the ticket, as a citizen reads it out.
 *
 * `generateSessionCode` writes `KMCP-` and six characters from an alphabet with
 * no 0/O or 1/I in it, and none of that is pinned down here on purpose: the
 * lookup is an exact match against a unique column, so a code that matches no
 * row is already a 404, and encoding the prefix and alphabet in the schema
 * would buy nothing while refusing outright any code from a pre-KMCP import or
 * a later format. Trimmed and bounded is all the validation this needs; the
 * service uppercases it, because nobody typing "kmcp-8f3k2q" means something
 * else by it.
 */
export const ClaimSessionSchema = z.object({
  code: z.string().trim().min(4).max(32),
});
export type ClaimSessionDto = z.infer<typeof ClaimSessionSchema>;

export const MySummaryQuerySchema = z.object({
  /** "2026-09". Defaults to the current month when omitted. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM")
    .optional(),
});
export type MySummaryQueryDto = z.infer<typeof MySummaryQuerySchema>;

export const MyPaymentsQuerySchema = PaginationSchema;
export type MyPaymentsQueryDto = z.infer<typeof MyPaymentsQuerySchema>;

export const AddFavouriteSchema = z.object({
  zoneId: z.string().min(1),
  label: z.string().trim().min(1).max(40).default("SAVED"),
});
export type AddFavouriteDto = z.infer<typeof AddFavouriteSchema>;
