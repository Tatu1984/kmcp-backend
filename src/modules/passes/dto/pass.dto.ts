import { z } from "zod";
import { PassStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

export const CreatePassPlanSchema = z.object({
  name: z.string().trim().min(3).max(120),
  vehicleTypeId: z.string().min(1),
  /**
   * Empty means city-wide.
   *
   * A plan scoped to nothing would be unsellable, so the absence of a list is
   * read as "everywhere" rather than "nowhere" — which is also how a citizen
   * reads "all zones" on the price card.
   */
  zoneIds: z.array(z.string()).default([]),
  durationDays: z.number().int().min(1).max(366),
  /** Paise, like every other amount in this API. */
  price: z.number().int().min(0),
  isActive: z.boolean().default(true),
});
export type CreatePassPlanDto = z.infer<typeof CreatePassPlanSchema>;

export const UpdatePassPlanSchema = CreatePassPlanSchema.partial();
export type UpdatePassPlanDto = z.infer<typeof UpdatePassPlanSchema>;

export const PassPlanQuerySchema = PaginationSchema.extend({
  isActive: z.coerce.boolean().optional(),
  vehicleTypeId: z.string().optional(),
});
export type PassPlanQueryDto = z.infer<typeof PassPlanQuerySchema>;

export const PassQuerySchema = PaginationSchema.extend({
  status: z.nativeEnum(PassStatus).optional(),
  planId: z.string().optional(),
  userId: z.string().optional(),
  vehicleId: z.string().optional(),
  /** Passes lapsing inside this many days — what a renewal chase works from. */
  expiringInDays: z.coerce.number().int().min(1).max(90).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type PassQueryDto = z.infer<typeof PassQuerySchema>;

export const CancelPassSchema = z.object({
  reason: z.string().trim().min(4, "A cancellation needs a reason").max(500),
});
export type CancelPassDto = z.infer<typeof CancelPassSchema>;
