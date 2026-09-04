import { z } from "zod";
import { SlotStatus, SlotType } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

const CODE = /^[A-Z0-9-]+$/;

export const CreateSlotSchema = z.object({
  zoneId: z.string().min(1),
  code: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .toUpperCase()
    .regex(CODE, "Use letters, digits and hyphens only"),
  type: z.nativeEnum(SlotType),
  isReserved: z.boolean().default(false),
});
export type CreateSlotDto = z.infer<typeof CreateSlotSchema>;

/**
 * Bays are painted in runs, not one at a time. Numbering a stretch of kerb by
 * hand is where transcription errors come from, so the server generates the run.
 */
export const BulkCreateSlotsSchema = z
  .object({
    zoneId: z.string().min(1),
    prefix: z
      .string()
      .trim()
      .min(1)
      .max(8)
      .toUpperCase()
      .regex(CODE, "Use letters, digits and hyphens only"),
    from: z.number().int().min(1).max(9999),
    to: z.number().int().min(1).max(9999),
    type: z.nativeEnum(SlotType),
    isReserved: z.boolean().default(false),
    /** Zero-pads the number, so B-007 sorts next to B-008 rather than B-70. */
    pad: z.number().int().min(1).max(4).default(3),
  })
  .refine((d) => d.to >= d.from, { message: "The range ends before it starts", path: ["to"] })
  .refine((d) => d.to - d.from + 1 <= 500, {
    message: "Create at most 500 bays at a time",
    path: ["to"],
  });
export type BulkCreateSlotsDto = z.infer<typeof BulkCreateSlotsSchema>;

export const UpdateSlotSchema = z.object({
  type: z.nativeEnum(SlotType).optional(),
  isReserved: z.boolean().optional(),
});
export type UpdateSlotDto = z.infer<typeof UpdateSlotSchema>;

export const SlotStatusSchema = z
  .object({
    status: z.nativeEnum(SlotStatus),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((d) => d.status !== SlotStatus.OUT_OF_SERVICE || (d.reason?.length ?? 0) > 3, {
    message: "Say why the bay is out of service",
    path: ["reason"],
  });
export type SlotStatusDto = z.infer<typeof SlotStatusSchema>;

export const SlotQuerySchema = PaginationSchema.extend({
  zoneId: z.string().optional(),
  status: z.nativeEnum(SlotStatus).optional(),
  type: z.nativeEnum(SlotType).optional(),
  isReserved: z.coerce.boolean().optional(),
});
export type SlotQueryDto = z.infer<typeof SlotQuerySchema>;
