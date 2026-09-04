import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationChannel } from "@prisma/client";

import type { Env } from "@/config/env.config";
import type { DeliverableChannel, MessageProvider, OutboundMessage, SendOutcome } from "./provider.types";
import { isRetryableStatus, postJson, transportFailure } from "./provider-http";

const ENDPOINT = "https://control.msg91.com/api/v5/flow";

/**
 * SMS, over MSG91.
 *
 * MSG91 is what Indian municipal deployments have DLT-registered sender ids
 * with, and DLT is why this posts to the `flow` endpoint rather than a plain
 * "send this text" one: on Indian networks the *content* is registered with the
 * regulator ahead of time and a message is sent by naming a registered template
 * and supplying its variables. We therefore send our rendered body as the
 * single `body` variable of one registered transactional template, which keeps
 * the wording in this codebase (where every channel renders from the same
 * facts) instead of scattered across a provider's dashboard.
 *
 * Written against the REST API rather than the `msg91` package, for the same
 * reason RazorpayService is: an ESM-only dependency has already broken this
 * API's boot on Vercel twice, and an HTTP POST needs no dependency at all.
 */
@Injectable()
export class Msg91SmsProvider implements MessageProvider {
  readonly channel: DeliverableChannel = NotificationChannel.SMS;
  readonly name = "msg91";

  private readonly logger = new Logger(Msg91SmsProvider.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get("MSG91_AUTH_KEY", { infer: true }) &&
        this.config.get("MSG91_SENDER_ID", { infer: true }),
    );
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    const authKey = this.config.get("MSG91_AUTH_KEY", { infer: true });
    const senderId = this.config.get("MSG91_SENDER_ID", { infer: true });

    if (!authKey || !senderId) {
      // The no-op path. Note what is *not* here: no throw, and no silent
      // success. The intent is handed back to the caller, which records it as a
      // FAILED delivery carrying this reason, so a developer running locally
      // sees exactly what would have been sent and to whom, and an operator on
      // a half-provisioned deployment is told why nothing arrived.
      return {
        ok: false,
        unconfigured: true,
        retryable: false,
        reason: "SMS is not configured on this deployment (MSG91_AUTH_KEY, MSG91_SENDER_ID).",
      };
    }

    const to = normaliseIndianMsisdn(message.to);
    if (!to) {
      return { ok: false, retryable: false, reason: "That is not a valid mobile number." };
    }

    const result = await postJson(
      ENDPOINT,
      { authkey: authKey },
      {
        template_id: this.config.get("MSG91_TEMPLATE_ID", { infer: true }) ?? message.template,
        sender: senderId,
        short_url: "0",
        recipients: [{ mobiles: to, body: message.body }],
      },
    );

    if ("transportError" in result) return transportFailure("MSG91", result.transportError);

    // MSG91 answers 200 with `{ type: "error" }` for a rejected send, so the
    // status code alone is not the verdict.
    const type = typeof result.body?.type === "string" ? result.body.type : undefined;
    const rejected = result.status >= 400 || type === "error";

    if (rejected) {
      const detail = readMessage(result.body) ?? `HTTP ${result.status}`;
      // DPDP: the recipient's number is not in this line, and neither is the
      // message body. The template key is enough to find the delivery row.
      this.logger.warn(`MSG91 refused "${message.template}": ${detail}`);
      return {
        ok: false,
        retryable: isRetryableStatus(result.status),
        reason: `MSG91 refused the message: ${detail}`,
      };
    }

    const providerRef = typeof result.body?.request_id === "string" ? result.body.request_id : "";
    return { ok: true, providerRef: providerRef || `msg91:${Date.now()}` };
  }
}

/**
 * MSG91 wants a country-coded number with no `+`.
 *
 * Ten digits are assumed Indian, which is true of every number this platform
 * holds — citizens register with an Indian mobile — but a number that already
 * carries a country code is left alone rather than having 91 prepended to it.
 */
export function normaliseIndianMsisdn(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

function readMessage(body: Record<string, unknown> | null): string | undefined {
  const message = body?.message;
  if (typeof message === "string") return message;
  // MSG91 sometimes returns `message` as an object keyed by number.
  if (message && typeof message === "object") return JSON.stringify(message).slice(0, 200);
  return undefined;
}
