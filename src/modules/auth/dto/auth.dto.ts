import { z } from "zod";

/**
 * Sign in with an email or a mobile number.
 *
 * Portal staff have work email addresses; attendants generally do not — they
 * are hired with a phone and a shift, and typing an email on a handset at a
 * kerb is a worse experience for the person who uses this platform most. Either
 * identifies the account, and exactly one must be given.
 */
export const LoginSchema = z
  .object({
    email: z.string().email("Enter a valid work email address").optional(),
    phone: z
      .string()
      .regex(/^(\+91)?[6-9]\d{9}$/, "Enter a valid Indian mobile number")
      .transform((p) => (p.startsWith("+91") ? p : `+91${p}`))
      .optional(),
    password: z.string().min(6, "Your password is at least 6 characters"),
    deviceFingerprint: z.string().min(8).max(128).optional(),
    platform: z.enum(["web", "ios", "android"]).default("web"),
    /** Browser timezone. A mismatch against the IP's timezone is a signal. */
    timezone: z.string().max(64).optional(),
  })
  .refine((dto) => Boolean(dto.email) !== Boolean(dto.phone), {
    message: "Sign in with either an email address or a mobile number",
    path: ["email"],
  });
export type LoginDto = z.infer<typeof LoginSchema>;

export const TwoFactorSchema = z.object({
  challengeId: z.string().min(10),
  code: z.string().regex(/^\d{6}$/, "Enter the six-digit code"),
});
export type TwoFactorDto = z.infer<typeof TwoFactorSchema>;

/**
 * A citizen signs in with an email address and a code sent to it.
 *
 * Lower-cased and trimmed here so the account is found by one spelling of the
 * address however it was typed — the same reason a phone is normalised to +91.
 */
const EmailSchema = z.string().trim().toLowerCase().email("Enter a valid email address");

export const OtpRequestSchema = z.object({
  email: EmailSchema,
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

/** The rules for any password a person chooses, on change or on reset. */
const NewPasswordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/\d/, "Include a number");

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(6),
    newPassword: NewPasswordSchema,
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

/** Asks for another emailed code for a sign-in already in progress. */
export const ResendChallengeSchema = z.object({
  challengeId: z.string().min(10),
});
export type ResendChallengeDto = z.infer<typeof ResendChallengeSchema>;

/**
 * Staff who forgot their password identify the account the same way they sign
 * in — a mobile number or an email — and the code goes to the email on file.
 */
const AccountIdentifierSchema = z.object({
  email: EmailSchema.optional(),
  phone: z
    .string()
    .regex(/^(\+91)?[6-9]\d{9}$/, "Enter a valid Indian mobile number")
    .transform((p) => (p.startsWith("+91") ? p : `+91${p}`))
    .optional(),
});

export const ForgotPasswordSchema = AccountIdentifierSchema.refine(
  (dto) => Boolean(dto.email) !== Boolean(dto.phone),
  { message: "Give either an email address or a mobile number", path: ["email"] },
);
export type ForgotPasswordDto = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = AccountIdentifierSchema.extend({
  code: z.string().regex(/^\d{6}$/, "Enter the six digits we sent you"),
  newPassword: NewPasswordSchema,
}).refine((dto) => Boolean(dto.email) !== Boolean(dto.phone), {
  message: "Give either an email address or a mobile number",
  path: ["email"],
});
export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>;
