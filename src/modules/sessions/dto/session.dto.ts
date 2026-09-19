import { z } from "zod";
import { SessionSource, SessionStatus, SlotType } from "@prisma/client";
import { PaginationSchema } from "@/common/dto/pagination.dto";

const Coordinate = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const StartSessionSchema = z.object({
  /**
   * The attendant's own id for this event, generated on the device.
   *
   * This is what makes an offline queue safe: the handset may replay the same
   * start a dozen times as connectivity comes and goes, and every replay must
   * resolve to one parking session and one fare.
   */
  clientEventId: z.string().trim().min(8).max(64).optional(),

  zoneId: z.string().min(1),

  /**
   * The specific bay, when the attendant allocated one.
   *
   * Optional at this layer and validated hard in the service. It has to stay
   * optional: a zone's priced capacity and its painted bays are separate
   * things, most zones have fewer of the second than the first, and a session
   * entered in the portal or replayed from an offline queue may name no bay at
   * all. The vendor app insists on one where the zone actually has bays — that
   * is a decision about a screen, not about what the API can accept.
   *
   * `min(1)` because an empty string is not "no bay": it is a bay id that
   * cannot exist, and it used to reach the insert and fail there as a foreign
   * key error rather than as a refusal anyone could read.
   */
  slotId: z.string().min(1).optional(),

  /**
   * Typed by the attendant from the plate. Phase 1 has no ANPR — the
   * photograph is the evidence, the typed number is the record.
   */
  plateNumber: z.string().trim().min(4).max(16),
  vehicleType: z.nativeEnum(SlotType),

  /** Where the attendant was standing. The server decides if that is in the zone. */
  location: Coordinate.optional(),

  /** Media id of the plate photograph, from the two-step upload. */
  evidenceMediaId: z.string().optional(),

  /** When it happened, not when it synced. Defaults to now for online starts. */
  startedAt: z.coerce.date().optional(),

  source: z.nativeEnum(SessionSource).optional(),
  makeModel: z.string().trim().max(80).optional(),
  colour: z.string().trim().max(40).optional(),
});
export type StartSessionDto = z.infer<typeof StartSessionSchema>;

export const EndSessionSchema = z.object({
  clientEventId: z.string().trim().min(8).max(64).optional(),
  location: Coordinate.optional(),
  evidenceMediaId: z.string().optional(),
  endedAt: z.coerce.date().optional(),
  discountCode: z.string().trim().max(32).optional(),
});
export type EndSessionDto = z.infer<typeof EndSessionSchema>;

export const CancelSessionSchema = z.object({
  reason: z.string().trim().min(4, "Say why this session is being cancelled").max(500),
});
export type CancelSessionDto = z.infer<typeof CancelSessionSchema>;

export const SessionQuerySchema = PaginationSchema.extend({
  status: z.nativeEnum(SessionStatus).optional(),
  zoneId: z.string().optional(),
  vendorId: z.string().optional(),
  attendantId: z.string().optional(),
  plateNumber: z.string().trim().max(16).optional(),
  vehicleType: z.nativeEnum(SlotType).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Only sessions past the overstay threshold. */
  overstayOnly: z.coerce.boolean().optional(),
});
export type SessionQueryDto = z.infer<typeof SessionQuerySchema>;

/** What the attendant sees before deciding whether to start or end a session. */
export const PlateLookupSchema = z.object({
  plateNumber: z.string().trim().min(4).max(16),
});
export type PlateLookupDto = z.infer<typeof PlateLookupSchema>;
