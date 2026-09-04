import { z } from "zod";
import { NotificationChannel, ReportFrequency } from "@prisma/client";

import { APP } from "@/config/app.constants";
import { PaginationSchema } from "@/common/dto/pagination.dto";
import { REPORT_KEYS } from "../report-types";

/**
 * The channels a finished report may be announced on.
 *
 * `IN_APP` is not listed and is not a choice: the portal bell is raised for
 * every run regardless, because the officer who set the schedule up is by
 * definition someone who signs in. What this field selects is what *leaves the
 * building* — and PUSH is absent for the same reason it is absent from the
 * messaging module, namely that there is no device token registry to send to.
 */
const DeliveryChannel = z.enum([
  NotificationChannel.SMS,
  NotificationChannel.WHATSAPP,
  NotificationChannel.EMAIL,
]);

/**
 * The recurrence and the report, as the portal collects them.
 *
 * There is no `from`/`to` here and that is the point of the whole feature: a
 * schedule holds the question, and the runner derives the period from the
 * cadence when it fires. A stored period would mean the "daily" collection
 * report kept re-reporting the same day forever.
 *
 * There is no `ownerId` either. A schedule always belongs to the account that
 * created it — the same rule `MessagingService.emailReport` follows, and for
 * the same reason: a field for someone else's id is a way to have a report run
 * under a principal that may see more than you do.
 */
const ScheduleFields = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(REPORT_KEYS),
  frequency: z.nativeEnum(ReportFrequency),
  /**
   * Local wall clock in `timezone`. Not UTC — see `recurrence.ts`.
   *
   * Any minute is accepted, but the scheduler ticks every quarter of an hour
   * (`vercel.json`), so a schedule fires on the first sweep at or after its
   * local time: 06:07 runs at 06:15. Rounding the field to quarters would have
   * made the stored value a lie about what the officer asked for; the delay is
   * bounded, visible in `nextRunAt`, and the honest half of the trade.
   */
  hour: z.coerce.number().int().min(0).max(23).default(6),
  minute: z.coerce.number().int().min(0).max(59).default(0),
  /** ISO weekday, 1 = Monday … 7 = Sunday. Required when the frequency is WEEKLY. */
  weekday: z.coerce.number().int().min(1).max(7).nullish(),
  /** 1–31; a value past the end of a short month is clamped, not rolled over. */
  dayOfMonth: z.coerce.number().int().min(1).max(31).nullish(),
  /**
   * The zone the hour is spoken in. Defaults to the platform's own, which is
   * what every screen already renders; it is settable so an authority elsewhere
   * is not forced to do arithmetic in its head.
   */
  timezone: z.string().trim().min(1).max(64).default(APP.timezone),
  zoneId: z.string().nullish(),
  vendorId: z.string().nullish(),
  /** Only CSV is produced, exactly as for an interactive run. */
  format: z.literal("csv").default("csv"),
  channels: z.array(DeliveryChannel).min(1).max(3).default([NotificationChannel.EMAIL]),
  isActive: z.boolean().default(true),
});

export const CreateReportScheduleSchema = ScheduleFields;
export type CreateReportScheduleDto = z.infer<typeof CreateReportScheduleSchema>;

/**
 * Every field optional, and the cross-field rules deliberately *not* checked
 * here.
 *
 * A patch that sends only `frequency: "MONTHLY"` is valid on its own and
 * invalid against the row it lands on, which has no day of the month. So the
 * merged rule is what gets validated, in the service, by the same
 * `assertValidRecurrence` the create path uses — one rule, one place, and no
 * way to reach the table through the patch route that the create route would
 * have refused.
 */
export const UpdateReportScheduleSchema = ScheduleFields.partial();
export type UpdateReportScheduleDto = z.infer<typeof UpdateReportScheduleSchema>;

export const ReportScheduleQuerySchema = PaginationSchema.extend({
  type: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
  /** Narrows an unrestricted caller's view to their own, as `?mine=` does for jobs. */
  mine: z.coerce.boolean().optional(),
});
export type ReportScheduleQueryDto = z.infer<typeof ReportScheduleQuerySchema>;
