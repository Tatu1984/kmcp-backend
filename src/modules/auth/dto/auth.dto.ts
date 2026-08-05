import { z } from "zod";

export const LoginSchema = z.object({
  email: z.string().email("Enter a valid work email address"),
  password: z.string().min(6, "Your password is at least 6 characters"),
  deviceFingerprint: z.string().min(8).max(128).optional(),
  platform: z.enum(["web", "ios", "android"]).default("web"),
});
export type LoginDto = z.infer<typeof LoginSchema>;

export const TwoFactorSchema = z.object({
  challengeId: z.string().min(10),
  code: z.string().regex(/^\d{6}$/, "Enter the six digits from your authenticator app"),
});
export type TwoFactorDto = z.infer<typeof TwoFactorSchema>;

export const OtpRequestSchema = z.object({
  phone: z
    .string()
    .regex(/^(\+91)?[6-9]\d{9}$/, "Enter a valid Indian mobile number")
    .transform((p) => (p.startsWith("+91") ? p : `+91${p}`)),
});
export type OtpRequestDto = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = OtpRequestSchema.extend({
  code: z.string().regex(/^\d{6}$/, "Enter the six digits we sent you"),
  name: z.string().trim().min(2).max(80).optional(),
  deviceFingerprint: z.string().min(8).max(128).optional(),
  platform: z.enum(["ios", "android"]).default("android"),
  pushToken: z.string().max(255).optional(),
});
export type OtpVerifyDto = z.infer<typeof OtpVerifySchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(20),
});
export type RefreshDto = z.infer<typeof RefreshSchema>;

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(6),
    newPassword: z
      .string()
      .min(10, "Use at least 10 characters")
      .regex(/[a-z]/, "Include a lowercase letter")
      .regex(/[A-Z]/, "Include an uppercase letter")
      .regex(/\d/, "Include a number"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "The two passwords do not match",
    path: ["confirmPassword"],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: "Choose a password you have not used here before",
    path: ["newPassword"],
  });
export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>;

export const BindDeviceSchema = z.object({
  fingerprint: z.string().min(8).max(128),
  platform: z.enum(["ios", "android", "web"]),
  appVersion: z.string().max(20).optional(),
  pushToken: z.string().max(255).optional(),
});
export type BindDeviceDto = z.infer<typeof BindDeviceSchema>;

export const VerifyTotpSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});
export type VerifyTotpDto = z.infer<typeof VerifyTotpSchema>;
