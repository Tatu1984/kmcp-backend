import { z } from "zod";

/**
 * The period and filter an audit export covers.
 *
 * The period is mandatory and has no default. An export with an implied period
 * is an export nobody can describe afterwards, and the fingerprint printed on
 * the document is only checkable if two people can agree on exactly what was
 * asked for.
 */
export const AuditTrailQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    action: z.string().max(64).optional(),
    entity: z.string().max(64).optional(),
    entityId: z.string().max(64).optional(),
    actorUserId: z.string().max(64).optional(),
  })
  .refine((value) => value.from <= value.to, {
    message: "the period ends before it starts",
    path: ["to"],
  });

export type AuditTrailQueryDto = z.infer<typeof AuditTrailQuerySchema>;
