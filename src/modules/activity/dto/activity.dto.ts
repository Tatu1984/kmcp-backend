import { z } from "zod";
import { AuthEventType, LocationConsentStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

export const ActivityQuerySchema = PaginationSchema.extend({
  userId: z.string().optional(),
  eventType: z.nativeEnum(AuthEventType).optional(),
  ip: z.string().max(64).optional(),
  city: z.string().max(120).optional(),
  /** Only sign-ins the anomaly engine scored above zero. */
  flaggedOnly: z.coerce.boolean().optional(),
  minRisk: z.coerce.number().int().min(0).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ActivityQueryDto = z.infer<typeof ActivityQuerySchema>;

export const ApproveEventSchema = z.object({
  label: z.string().trim().max(120).optional(),
});
export type ApproveEventDto = z.infer<typeof ApproveEventSchema>;

export const RevokeSessionSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});
export type RevokeSessionDto = z.infer<typeof RevokeSessionSchema>;

export const ConsentSchema = z
  .object({
    status: z.nativeEnum(LocationConsentStatus),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    accuracyM: z.number().min(0).max(100_000).optional(),
  })
  .refine(
    (d) =>
      d.status !== LocationConsentStatus.GRANTED ||
      (d.latitude === undefined) === (d.longitude === undefined),
    { message: "Send both latitude and longitude, or neither", path: ["longitude"] },
  );
export type ConsentDto = z.infer<typeof ConsentSchema>;

/** Client hints the apps forward on login to sharpen the device fingerprint. */
export const ClientHintsSchema = z.object({
  timezone: z.string().max(64).optional(),
  screen: z.string().max(32).optional(),
  language: z.string().max(32).optional(),
  platform: z.string().max(64).optional(),
});
export type ClientHintsDto = z.infer<typeof ClientHintsSchema>;
