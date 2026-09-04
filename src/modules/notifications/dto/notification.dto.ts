import { z } from "zod";
import { PaginationSchema } from "@/common/dto/pagination.dto";

export const NotificationQuerySchema = PaginationSchema.extend({
  /** Only those not yet read. What the bell's badge counts. */
  unreadOnly: z.coerce.boolean().optional(),
});
export type NotificationQueryDto = z.infer<typeof NotificationQuerySchema>;

/**
 * What a notification says, once the template has been rendered.
 *
 * The row stores `template` and a `payload` blob so a future delivery module
 * can re-render the same alert for SMS or email without the wording being
 * frozen into the database. Until that module exists the portal reads these
 * two fields directly, so they are part of the contract rather than free-form.
 */
export const NotificationPayloadSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().max(600).optional(),
  /** Where the alert points in the portal, e.g. `/settlements/stl_1`. */
  href: z.string().trim().max(300).optional(),
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;
