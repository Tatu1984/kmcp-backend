import { z } from "zod";
import { UserStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

export const CitizenQuerySchema = PaginationSchema.extend({
  status: z.nativeEnum(UserStatus).optional(),
  /** Only those holding a live pass. */
  withPass: z.coerce.boolean().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type CitizenQueryDto = z.infer<typeof CitizenQuerySchema>;

export const CitizenStatusSchema = z.object({
  status: z.nativeEnum(UserStatus),
  reason: z.string().trim().min(4, "Say why").max(500),
});
export type CitizenStatusDto = z.infer<typeof CitizenStatusSchema>;

export const VehicleBlacklistSchema = z.object({
  isBlacklisted: z.boolean(),
  reason: z.string().trim().min(4, "Say why").max(500),
});
export type VehicleBlacklistDto = z.infer<typeof VehicleBlacklistSchema>;
