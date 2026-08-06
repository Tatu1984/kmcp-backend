import { z } from "zod";
import { UserRole, UserStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

/**
 * Portal staff only. Vendors, attendants and citizens are created through their
 * own flows, which build the records that hang off the login — a VENDOR user
 * with no Vendor row would be able to sign in and see nothing.
 */
export const STAFF_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.ZONE_OFFICER,
  UserRole.AUDITOR,
] as const;

const StaffRole = z.enum(STAFF_ROLES);
const PHONE = /^\+?[1-9]\d{7,14}$/;

export const CreateUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().transform((e) => e.toLowerCase()),
  phone: z.string().trim().regex(PHONE, "Use an international format number").optional(),
  role: StaffRole,
  password: z.string().min(10, "At least 10 characters for a portal account").max(128),
  /** Only meaningful for a zone officer. */
  zoneIds: z.array(z.string().min(1)).optional(),
});
export type CreateUserDto = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().email().transform((e) => e.toLowerCase()).optional(),
  phone: z.string().trim().regex(PHONE, "Use an international format number").optional(),
});
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>;

export const ChangeRoleSchema = z.object({
  role: StaffRole,
  reason: z.string().trim().min(4, "Say why").max(500),
});
export type ChangeRoleDto = z.infer<typeof ChangeRoleSchema>;

export const ChangeUserStatusSchema = z.object({
  status: z.nativeEnum(UserStatus),
  reason: z.string().trim().min(4, "Say why").max(500),
});
export type ChangeUserStatusDto = z.infer<typeof ChangeUserStatusSchema>;

export const ResetPasswordSchema = z.object({
  password: z.string().min(10).max(128),
  reason: z.string().trim().min(4, "Say why").max(500),
});
export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>;

export const AssignZonesSchema = z.object({
  zoneIds: z.array(z.string().min(1)),
});
export type AssignZonesDto = z.infer<typeof AssignZonesSchema>;

export const UserQuerySchema = PaginationSchema.extend({
  role: z.nativeEnum(UserRole).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  staffOnly: z.coerce.boolean().default(true),
});
export type UserQueryDto = z.infer<typeof UserQuerySchema>;
