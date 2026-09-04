import { z } from "zod";

import { PaginationSchema } from "@/common/dto/pagination.dto";
import { DELIVERABLE_CHANNELS } from "../providers/provider.types";

/**
 * Only the three channels this module can actually put a message onto. IN_APP
 * is NotificationsService's job and PUSH has no device registry yet, so neither
 * is accepted here — a caller asking for one is making a mistake, and being
 * told so at the edge is better than a delivery row that never moves.
 */
export const ChannelSchema = z.enum(
  DELIVERABLE_CHANNELS as unknown as [string, ...string[]],
);

const Channels = z
  .array(ChannelSchema)
  .min(1, "Choose at least one channel")
  .max(DELIVERABLE_CHANNELS.length)
  // A screen that offers "SMS and email" must not be able to send two SMS.
  .transform((list) => [...new Set(list)]);

/**
 * Bulk sends are capped.
 *
 * Not an arbitrary limit: each message is attempted inline, with up to three
 * provider round-trips, inside the request the operator is waiting on. Two
 * hundred is roughly the largest selection that still returns before a
 * serverless function's timeout, and a screen that needs more than that wants a
 * scheduled campaign, which is a different feature with different consent.
 */
const Ids = z.array(z.string().trim().min(1)).min(1).max(200);

export const SendReceiptSchema = z
  .object({
    paymentIds: Ids.optional(),
    /** Accepted because the sessions screen holds session ids, not payment ids. */
    sessionIds: Ids.optional(),
    channels: Channels,
  })
  .refine((v) => Boolean(v.paymentIds?.length || v.sessionIds?.length), {
    message: "Give at least one payment or session",
    path: ["paymentIds"],
  });
export type SendReceiptDto = z.infer<typeof SendReceiptSchema>;

export const SendPassSchema = z.object({
  passIds: Ids,
  /**
   * `issued` sends the pass itself; `renewal` prompts the holder to buy the
   * next one. Two different messages about the same pass, so the caller says
   * which rather than the server guessing from the expiry date.
   */
  kind: z.enum(["issued", "renewal"]).default("issued"),
  channels: Channels,
});
export type SendPassDto = z.infer<typeof SendPassSchema>;

export const SendAnnouncementSchema = z.object({
  citizenIds: Ids,
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(600),
  url: z.string().trim().url().max(300).optional(),
  channels: Channels,
});
export type SendAnnouncementDto = z.infer<typeof SendAnnouncementSchema>;

/**
 * Emailing a report to the person who asked for it. No recipient field, by
 * design: "email to me" means the signed-in account, and a route that let an
 * officer type an address would be an exfiltration path for a spreadsheet of
 * plate numbers.
 */
export const EmailReportSchema = z.object({
  reportName: z.string().trim().min(1).max(120),
  format: z.string().trim().min(1).max(16),
  rangeLabel: z.string().trim().max(120).optional(),
  rowCount: z.coerce.number().int().nonnegative().optional(),
  url: z.string().trim().max(600).optional(),
});
export type EmailReportDto = z.infer<typeof EmailReportSchema>;

export const DeliveryQuerySchema = PaginationSchema.extend({
  channel: ChannelSchema.optional(),
  status: z.enum(["QUEUED", "SENT", "DELIVERED", "FAILED"]).optional(),
  template: z.string().trim().max(60).optional(),
  /** Everything sent to one person — the "did they get it?" question. */
  userId: z.string().trim().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type DeliveryQueryDto = z.infer<typeof DeliveryQuerySchema>;
