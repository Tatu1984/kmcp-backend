import { z } from "zod";
import { VendorStatus } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

/** Indian statutory identifiers, validated at the boundary rather than at payout time. */
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const CreateVendorSchema = z.object({
  orgName: z.string().trim().min(2).max(160),
  contactName: z.string().trim().min(2).max(120),
  contactPhone: z
    .string()
    .regex(/^(\+91)?[6-9]\d{9}$/, "Enter a valid Indian mobile number")
    .transform((p) => (p.startsWith("+91") ? p : `+91${p}`)),
  email: z.string().email(),
  gstin: z.string().trim().toUpperCase().regex(GSTIN, "That is not a valid GSTIN").optional(),
  pan: z.string().trim().toUpperCase().regex(PAN, "That is not a valid PAN").optional(),
  bankAccountName: z.string().trim().max(160).optional(),
  bankAccountNo: z.string().trim().regex(/^\d{6,20}$/, "Digits only").optional(),
  bankIfsc: z.string().trim().toUpperCase().regex(IFSC, "That is not a valid IFSC").optional(),
  commissionPct: z.number().min(0).max(60).default(18),
  /** Sets the initial password for the vendor's portal login. */
  password: z.string().min(10).optional(),
});
export type CreateVendorDto = z.infer<typeof CreateVendorSchema>;

export const UpdateVendorSchema = CreateVendorSchema.partial().omit({ password: true });
export type UpdateVendorDto = z.infer<typeof UpdateVendorSchema>;

export const VendorQuerySchema = PaginationSchema.extend({
  status: z.nativeEnum(VendorStatus).optional(),
  kycComplete: z.coerce.boolean().optional(),
});
export type VendorQueryDto = z.infer<typeof VendorQuerySchema>;

export const VendorStatusSchema = z
  .object({
    status: z.nativeEnum(VendorStatus),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((d) => d.status === VendorStatus.APPROVED || (d.reason?.length ?? 0) > 3, {
    message: "Record why the vendor's status is changing",
    path: ["reason"],
  });
export type VendorStatusDto = z.infer<typeof VendorStatusSchema>;

export const AddDocumentSchema = z.object({
  type: z.enum(["AGREEMENT", "GST", "PAN", "BANK_PROOF", "KYC", "OTHER"]),
  mediaId: z.string().min(1),
});
export type AddDocumentDto = z.infer<typeof AddDocumentSchema>;

export const AssignZonesSchema = z.object({
  zoneIds: z.array(z.string().min(1)).min(1, "Pick at least one zone"),
  /** Replace the vendor's assignments rather than adding to them. */
  replace: z.boolean().default(false),
});
export type AssignZonesDto = z.infer<typeof AssignZonesSchema>;

export const CommissionSchema = z.object({
  commissionPct: z.number().min(0).max(60),
  reason: z.string().trim().min(4).max(500),
});
export type CommissionDto = z.infer<typeof CommissionSchema>;
