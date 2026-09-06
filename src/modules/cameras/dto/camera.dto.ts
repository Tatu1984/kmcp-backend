import { z } from "zod";
import { CameraStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

export const CreateCameraSchema = z.object({
  streetId: z.string().min(1, "A camera is bolted to a road"),
  code: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .toUpperCase()
    .regex(/^[A-Z0-9-]+$/, "Use letters, digits and hyphens only"),
  /** Where it points, in words an engineer standing on the pavement would use. */
  label: z.string().trim().min(3).max(120),
  makeModel: z.string().trim().max(80).optional(),
  /**
   * Names this camera's stream on the gateway.
   *
   * Deliberately not a URL and deliberately not credentials: the gateway holds
   * the connection to the camera, and a client is never handed anything it
   * could reconnect with on its own.
   */
  streamKey: z.string().trim().max(120).optional(),
  installedAt: z.coerce.date().optional(),
});
export type CreateCameraDto = z.infer<typeof CreateCameraSchema>;

export const UpdateCameraSchema = CreateCameraSchema.partial().omit({ streetId: true }).extend({
  status: z.nativeEnum(CameraStatus).optional(),
});
export type UpdateCameraDto = z.infer<typeof UpdateCameraSchema>;

export const CameraQuerySchema = PaginationSchema.extend({
  streetId: z.string().optional(),
  zoneId: z.string().optional(),
  status: z.nativeEnum(CameraStatus).optional(),
  q: z.string().trim().max(80).optional(),
});
export type CameraQueryDto = z.infer<typeof CameraQuerySchema>;
