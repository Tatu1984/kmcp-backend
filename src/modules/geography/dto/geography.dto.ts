import { z } from "zod";
import { PaginationSchema } from "@/common/dto/pagination.dto";

export const CreateWardSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .toUpperCase()
    .regex(/^[A-Z0-9-]+$/, "Use letters, digits and hyphens only"),
  name: z.string().trim().min(2).max(120),
});
export type CreateWardDto = z.infer<typeof CreateWardSchema>;

export const UpdateWardSchema = CreateWardSchema.partial();
export type UpdateWardDto = z.infer<typeof UpdateWardSchema>;

export const WardQuerySchema = PaginationSchema;
export type WardQueryDto = z.infer<typeof WardQuerySchema>;

export const CreateStreetSchema = z.object({
  wardId: z.string().min(1, "A street belongs to a ward"),
  name: z.string().trim().min(2).max(160),
});
export type CreateStreetDto = z.infer<typeof CreateStreetSchema>;

export const UpdateStreetSchema = CreateStreetSchema.partial();
export type UpdateStreetDto = z.infer<typeof UpdateStreetSchema>;

export const StreetQuerySchema = PaginationSchema.extend({
  wardId: z.string().optional(),
});
export type StreetQueryDto = z.infer<typeof StreetQuerySchema>;
