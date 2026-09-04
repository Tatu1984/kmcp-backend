import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationChannel } from "@prisma/client";

import type { Env } from "@/config/env.config";
import type { DeliverableChannel, MessageProvider, OutboundMessage, SendOutcome } from "./provider.types";
import { isRetryableStatus, postJson, transportFailure } from "./provider-http";
import { normaliseIndianMsisdn } from "./msg91-sms.provider";

/**
 * Pinned rather than floating. Meta ships breaking changes behind version
 * numbers and deprecates old ones on a published schedule; a floating version
 * would mean the day Meta cuts over is the day receipts stop arriving, with
 * nothing in our own change log to explain it.
 */
const GRAPH_VERSION = "v21.0";

/**
 * WhatsApp, over Meta's Cloud API.
 *
 * One caveat is worth stating plainly, because it will surprise whoever
 * operates this: Meta only permits free-form text to a person who has messaged
 * the business within the last 24 hours. Outside that window a *template*
 * message — pre-approved by Meta — is the only thing that gets through, and
 * approval is a business process, not a code change.
 *
 * This adapter sends free-form text and lets Meta refuse what it will refuse.
 * That is deliberate: the refusal is recorded against the delivery row with
 * Meta's own reason, so an operator sees "outside the 24-hour window" rather
 * than a message that appeared to send and did not. When the authority has its
 * templates approved, this is the one method that changes.
 */
@Injectable()
export class WhatsAppCloudProvider implements MessageProvider {
  readonly channel: DeliverableChannel = NotificationChannel.WHATSAPP;
  readonly name = "whatsapp-cloud";

  private readonly logger = new Logger(WhatsAppCloudProvider.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get("WHATSAPP_PHONE_NUMBER_ID", { infer: true }) &&
        this.config.get("WHATSAPP_TOKEN", { infer: true }),
    );
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    const phoneNumberId = this.config.get("WHATSAPP_PHONE_NUMBER_ID", { infer: true });
    const token = this.config.get("WHATSAPP_TOKEN", { infer: true });

    if (!phoneNumberId || !token) {
      return {
        ok: false,
        unconfigured: true,
        retryable: false,
        reason:
          "WhatsApp is not configured on this deployment (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN).",
      };
    }

    const to = normaliseIndianMsisdn(message.to);
    if (!to) {
      return { ok: false, retryable: false, reason: "That is not a valid WhatsApp number." };
    }

    const result = await postJson(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { authorization: `Bearer ${token}` },
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        // Link previews off: a renewal link rendering as a fat card pushes the
        // amount and the expiry — the facts — off the first screen.
        text: { preview_url: false, body: message.body },
      },
    );

    if ("transportError" in result) return transportFailure("WhatsApp", result.transportError);

    if (result.status >= 400) {
      const detail = readGraphError(result.body) ?? `HTTP ${result.status}`;
      // DPDP: template key only. No number, no body.
      this.logger.warn(`WhatsApp refused "${message.template}": ${detail}`);
      return {
        ok: false,
        retryable: isRetryableStatus(result.status),
        reason: `WhatsApp refused the message: ${detail}`,
      };
    }

    const messages = Array.isArray(result.body?.messages) ? result.body.messages : [];
    const first = messages[0] as { id?: unknown } | undefined;
    const providerRef = typeof first?.id === "string" ? first.id : "";
    return { ok: true, providerRef: providerRef || `wa:${Date.now()}` };
  }
}

/** Graph errors arrive as `{ error: { message, code, error_subcode } }`. */
function readGraphError(body: Record<string, unknown> | null): string | undefined {
  const error = body?.error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message.slice(0, 200);
  }
  return undefined;
}
