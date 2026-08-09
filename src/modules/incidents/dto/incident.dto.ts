import { z } from "zod";
import { IncidentStatus, IncidentType } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

export const CreateIncidentSchema = z
  .object({
    type: z.nativeEnum(IncidentType),
    description: z.string().trim().min(10, "Describe what happened").max(2000),
    /** One of these must be present — an incident nobody can locate is useless. */
    sessionId: z.string().optional(),
    zoneId: z.string().optional(),
    mediaIds: z.array(z.string()).max(10).default([]),
  })
  .refine((dto) => Boolean(dto.sessionId || dto.zoneId), {
    message: "An incident needs either a session or a zone",
    path: ["zoneId"],
  });
export type CreateIncidentDto = z.infer<typeof CreateIncidentSchema>;

export const AssignIncidentSchema = z.object({
  /** The portal user who will deal with it. */
  assignedTo: z.string().min(1),
  note: z.string().trim().max(500).optional(),
});
export type AssignIncidentDto = z.infer<typeof AssignIncidentSchema>;

export const ResolveIncidentSchema = z.object({
  /**
   * Deliberately required. "Resolved" with no account of what was done is not
   * a resolution, it is a closed tab — and this is the record a complaint gets
   * answered from months later.
   */
  resolutionNote: z.string().trim().min(10, "Say what was done").max(2000),
});
export type ResolveIncidentDto = z.infer<typeof ResolveIncidentSchema>;

export const RejectIncidentSchema = z.object({
  reason: z.string().trim().min(10, "Say why this is being rejected").max(2000),
});
export type RejectIncidentDto = z.infer<typeof RejectIncidentSchema>;

export const IncidentQuerySchema = PaginationSchema.extend({
  status: z.nativeEnum(IncidentStatus).optional(),
  type: z.nativeEnum(IncidentType).optional(),
  zoneId: z.string().optional(),
  sessionId: z.string().optional(),
  assignedTo: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Open and in-progress only — what a duty officer actually works from. */
  openOnly: z.coerce.boolean().optional(),
});
export type IncidentQueryDto = z.infer<typeof IncidentQuerySchema>;
