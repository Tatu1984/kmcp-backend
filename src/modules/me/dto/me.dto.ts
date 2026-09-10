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
