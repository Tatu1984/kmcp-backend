import { z } from "zod";
import { PaginationSchema } from "@/common/dto/pagination.dto";

const PHONE = /^\+?[1-9]\d{7,14}$/;

export const CreateAttendantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(PHONE, "Use an international format number, e.g. +919830011223"),
  email: z.string().trim().email().optional(),
  vendorId: z.string().min(1, "An attendant works for a vendor"),
  employeeCode: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .regex(/^[A-Z0-9-]+$/, "Use uppercase letters, digits and hyphens only")
    .transform((c) => c.toUpperCase()),
  defaultZoneId: z.string().optional(),
  /** Optional at creation — the attendant can be issued one when the device is handed over. */
  password: z.string().min(8).max(128).optional(),
});
export type CreateAttendantDto = z.infer<typeof CreateAttendantSchema>;

export const UpdateAttendantSchema = CreateAttendantSchema.partial().omit({
  vendorId: true,
  password: true,
});
export type UpdateAttendantDto = z.infer<typeof UpdateAttendantSchema>;

export const AttendantQuerySchema = PaginationSchema.extend({
  vendorId: z.string().optional(),
  zoneId: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
  onShift: z.coerce.boolean().optional(),
});
export type AttendantQueryDto = z.infer<typeof AttendantQuerySchema>;

export const AttendantStatusSchema = z.object({
  isActive: z.boolean(),
  reason: z.string().trim().min(4, "Say why").max(500),
});
export type AttendantStatusDto = z.infer<typeof AttendantStatusSchema>;

export const TransferAttendantSchema = z.object({
  vendorId: z.string().min(1),
  reason: z.string().trim().min(4, "Say why").max(500),
});
export type TransferAttendantDto = z.infer<typeof TransferAttendantSchema>;
