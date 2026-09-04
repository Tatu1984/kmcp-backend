import { z } from "zod";

/**
 * Configuration the authority can change without a deploy. The key is
 * namespaced (`ops.`, `tax.`, `settlement.`) so a screen can group them.
 *
 * `zoneScope:<userId>` rows live in the same table but are not configuration —
 * they are managed through user administration and hidden from this surface.
 */
export const CONFIG_NAMESPACES = [
  "ops",
  "tax",
  "settlement",
  "notification",
  "app",
  // How long each class of record is kept, plus the two brakes on the purge
  // that enforces it. Configuration rather than constants because the Act makes
  // the retention decision the authority's, not the vendor's — see
  // `modules/privacy/retention.policy.ts`.
  "retention",
] as const;

export const ConfigKeySchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+$/, "Use a namespaced key, e.g. ops.geofenceToleranceM")
  .refine((k) => CONFIG_NAMESPACES.includes(k.split(".")[0] as (typeof CONFIG_NAMESPACES)[number]), {
    message: `Namespace must be one of: ${CONFIG_NAMESPACES.join(", ")}`,
  });

export const SetConfigSchema = z.object({
  value: z.unknown().refine((v) => v !== undefined, { message: "A value is required" }),
  reason: z.string().trim().max(500).optional(),
});
export type SetConfigDto = z.infer<typeof SetConfigSchema>;

export const BulkConfigSchema = z.object({
  entries: z
    .array(z.object({ key: ConfigKeySchema, value: z.unknown() }))
    .min(1)
    .max(50),
  reason: z.string().trim().max(500).optional(),
});
export type BulkConfigDto = z.infer<typeof BulkConfigSchema>;

export const UpsertPageSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Lowercase letters, digits and hyphens only"),
  title: z.string().trim().min(2).max(200),
  bodyHtml: z.string().min(1).max(200_000),
  publish: z.boolean().default(false),
});
export type UpsertPageDto = z.infer<typeof UpsertPageSchema>;

export const UpsertFaqSchema = z.object({
  question: z.string().trim().min(4).max(300),
  answer: z.string().trim().min(4).max(5000),
  category: z.string().trim().max(60).optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});
export type UpsertFaqDto = z.infer<typeof UpsertFaqSchema>;

/**
 * Kept unrefined so the update schema can be derived from it — Zod refuses
 * `.partial()` on a schema that already carries a refinement.
 */
const BannerFields = z.object({
  title: z.string().trim().min(2).max(200),
  body: z.string().trim().max(2000).optional(),
  imageUrl: z.string().url().optional(),
  audience: z.enum(["CITIZEN", "VENDOR", "ALL"]),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  isActive: z.boolean().default(true),
});

const endsAfterItStarts = {
  message: "The banner ends before it starts",
  path: ["endAt"],
};

export const UpsertBannerSchema = BannerFields.refine((b) => b.endAt > b.startAt, endsAfterItStarts);
export type UpsertBannerDto = z.infer<typeof UpsertBannerSchema>;

/** On a partial edit the window is only checkable when both ends are supplied. */
export const UpdateBannerSchema = BannerFields.partial().refine(
  (b) => !b.startAt || !b.endAt || b.endAt > b.startAt,
  endsAfterItStarts,
);
export type UpdateBannerDto = z.infer<typeof UpdateBannerSchema>;
