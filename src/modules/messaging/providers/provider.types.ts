import { NotificationChannel } from "@prisma/client";

/**
 * The channels this module can actually put a message onto.
 *
 * `NotificationChannel` also carries `IN_APP` and `PUSH`. IN_APP is not a
 * delivery at all — NotificationsService writes those rows directly and the
 * portal reads them — and PUSH needs a device token registry that does not
 * exist yet. Narrowing the type here means a caller cannot ask a provider to
 * send an IN_APP message and get a runtime surprise; the compiler refuses it.
 */
export const DELIVERABLE_CHANNELS = [
  NotificationChannel.SMS,
  NotificationChannel.WHATSAPP,
  NotificationChannel.EMAIL,
] as const;

export type DeliverableChannel = (typeof DELIVERABLE_CHANNELS)[number];

export function isDeliverableChannel(value: string): value is DeliverableChannel {
  return (DELIVERABLE_CHANNELS as readonly string[]).includes(value);
}

/**
 * One message, addressed and already rendered.
 *
 * Providers never see the template or its payload. By the time a message
 * reaches an adapter the wording has been decided once, centrally, so two
 * adapters cannot render the same event differently — see `templates/`.
 */
export interface OutboundMessage {
  /** E.164 phone number for SMS and WhatsApp, an address for email. */
  to: string;
  /** Email only. Ignored by the SMS and WhatsApp adapters. */
  subject?: string;
  body: string;
  /**
   * The template key, carried through purely for diagnostics and for providers
   * that key their own approved templates off it. Never rendered.
   */
  template: string;
}

/**
 * What happened to one message.
 *
 * A discriminated union rather than a status string, so a caller that reads
 * `providerRef` has to have established the send succeeded first, and a caller
 * that reads `reason` has to have established it did not.
 */
export type SendOutcome =
  | { ok: true; providerRef: string }
  | {
      ok: false;
      /** Shown to the operator who asked for the send. Never a stack trace. */
      reason: string;
      /**
       * Whether trying again could plausibly work. A 500 from the provider or a
       * dropped socket is retryable; a malformed number or a rejected sender id
       * is not, and retrying it three times only wastes the operator's wait.
       */
      retryable: boolean;
      /**
       * True when the adapter did nothing because it holds no credentials.
       * Distinct from a refusal so the delivery log can say "this deployment
       * cannot send" rather than implying the provider rejected the message.
       */
      unconfigured?: boolean;
    };

/**
 * One way of putting a message in front of a person.
 *
 * Three implementations exist — MSG91 for SMS, the WhatsApp Cloud API, Resend
 * for email — and the registry picks between them by channel. Nothing outside
 * `providers/` imports a concrete adapter, which is what makes swapping MSG91
 * for a competitor a one-file change rather than a grep across the codebase.
 *
 * Every adapter must satisfy two rules:
 *
 *  1. With no credentials it is a no-op that reports `unconfigured`. Local
 *     development, CI and the demo build must not need live provider accounts,
 *     and must not need a fake-provider flag either — absent credentials *are*
 *     the signal.
 *  2. It never throws. A messaging failure must not roll back the business
 *     transaction that triggered it, and the surest way to guarantee that is
 *     for the failure never to become an exception in the first place.
 */
export interface MessageProvider {
  readonly channel: DeliverableChannel;
  /** The vendor behind this channel, recorded on the delivery row. */
  readonly name: string;
  /** False when the deployment holds no credentials for this provider. */
  isConfigured(): boolean;
  send(message: OutboundMessage): Promise<SendOutcome>;
}
