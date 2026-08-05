import { z } from "zod";
import { SlotType, ZoneStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const LinearRing = z
  .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
  .min(3, "A boundary needs at least three points");

export const GeoPolygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(LinearRing).min(1),
});

export const CreateZoneSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(16)
    .regex(/^[A-Z0-9-]+$/, "Use uppercase letters, digits and hyphens only")
    .transform((c) => c.toUpperCase()),
  name: z.string().trim().min(2).max(120),
  wardId: z.string().optional(),
  streetId: z.string().optional(),
  centerLat: z.number().min(-90).max(90),
  centerLng: z.number().min(-180).max(180),
  boundary: GeoPolygonSchema.optional(),
  capacity: z.number().int().min(1).max(5000),
  allowedVehicleTypeIds: z.array(z.nativeEnum(SlotType)).min(1, "Pick at least one vehicle type"),
  openTime: z.string().regex(TIME, "Use HH:MM"),
  closeTime: z.string().regex(TIME, "Use HH:MM"),
  vendorId: z.string().optional(),
});
export type CreateZoneDto = z.infer<typeof CreateZoneSchema>;

export const UpdateZoneSchema = CreateZoneSchema.partial().omit({ code: true });
export type UpdateZoneDto = z.infer<typeof UpdateZoneSchema>;

export const ZoneStatusSchema = z
  .object({
    status: z.nativeEnum(ZoneStatus),
    reason: z.string().trim().max(500).optional(),
    until: z.coerce.date().optional(),
  })
  .refine((d) => d.status === ZoneStatus.OPEN || (d.reason && d.reason.length > 3), {
    message: "Give citizens a reason for the closure",
    path: ["reason"],
  });
export type ZoneStatusDto = z.infer<typeof ZoneStatusSchema>;

export const ZoneQuerySchema = PaginationSchema.extend({
  status: z.nativeEnum(ZoneStatus).optional(),
  wardId: z.string().optional(),
  vendorId: z.string().optional(),
  /** Only zones with at least one free bay. */
  availableOnly: z.coerce.boolean().optional(),
});
export type ZoneQueryDto = z.infer<typeof ZoneQuerySchema>;

export const NearbySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().int().min(100).max(20_000).default(2000),
  vehicleType: z.nativeEnum(SlotType).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type NearbyDto = z.infer<typeof NearbySchema>;

export const ResolveZoneSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});
export type ResolveZoneDto = z.infer<typeof ResolveZoneSchema>;

export const AssignVendorSchema = z.object({
  vendorId: z.string().min(1),
});
export type AssignVendorDto = z.infer<typeof AssignVendorSchema>;
