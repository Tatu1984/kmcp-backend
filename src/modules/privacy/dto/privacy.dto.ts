import { z } from "zod";
import { ConsentPurpose } from "@prisma/client";

/**
 * Erasure is irreversible and it is a decision, not a click. The reason is
 * required and goes into the audit trail beside the officer's identity —
 * "because the citizen asked on 3 March, reference DPDP/2026/114" is what makes
 * the record defensible six months later.
 */
export const EraseCitizenSchema = z.object({
  reason: z.string().trim().min(8, "Say why, and cite the request").max(500),
  /**
   * Typed back by the officer, exactly. A confirmation dialogue is easy to
   * click through on the wrong row; retyping the citizen's own id is not.
   */
  confirmCitizenId: z.string().trim().min(1),
});
export type EraseCitizenDto = z.infer<typeof EraseCitizenSchema>;

/**
 * A correction may clear a field as well as change it — a mistyped email
 * address that belongs to nobody is better absent than wrong — so `null` is a
 * meaningful value here and is distinguished from the field being omitted.
 */
export const CorrectCitizenSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{10,15}$/, "Use digits, optionally with a country code")
      .nullable()
      .optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
    reason: z.string().trim().min(4, "Say why").max(500),
  })
  .refine((d) => d.name !== undefined || d.phone !== undefined || d.email !== undefined, {
    message: "Supply at least one of name, phone or email",
    path: ["name"],
  });
export type CorrectCitizenDto = z.infer<typeof CorrectCitizenSchema>;

export const RecordConsentSchema = z.object({
  purpose: z.nativeEnum(ConsentPurpose),
  granted: z.boolean(),
});
export type RecordConsentDto = z.infer<typeof RecordConsentSchema>;
