import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationChannel } from "@prisma/client";

import { APP } from "@/config/app.constants";
import type { Env } from "@/config/env.config";
import type { DeliverableChannel, MessageProvider, OutboundMessage, SendOutcome } from "./provider.types";
import { isRetryableStatus, postJson, transportFailure } from "./provider-http";

const ENDPOINT = "https://api.resend.com/emails";

/**
 * A from-address that will bounce if it is ever actually used, which is the
 * point: Resend refuses to send from an unverified domain, so a deployment that
 * forgot `RESEND_FROM_EMAIL` gets a clear refusal recorded against the delivery
 * row instead of mail quietly leaving under someone else's domain.
 */
const FALLBACK_FROM = `${APP.name} <no-reply@example.invalid>`;

/**
 * Email, over Resend.
 *
 * Both a plain-text and an HTML part go out. That is not belt-and-braces for
 * its own sake — a parking receipt is a document a citizen may need to forward
 * to an employer or a court, and text/plain is the part that survives being
 * quoted, printed and pasted intact.
 */
@Injectable()
export class ResendEmailProvider implements MessageProvider {
  readonly channel: DeliverableChannel = NotificationChannel.EMAIL;
  readonly name = "resend";

  private readonly logger = new Logger(ResendEmailProvider.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  isConfigured(): boolean {
    return Boolean(this.config.get("RESEND_API_KEY", { infer: true }));
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    const apiKey = this.config.get("RESEND_API_KEY", { infer: true });

    if (!apiKey) {
      return {
        ok: false,
        unconfigured: true,
        retryable: false,
        reason: "Email is not configured on this deployment (RESEND_API_KEY).",
      };
    }

    if (!isEmailAddress(message.to)) {
      return { ok: false, retryable: false, reason: "That is not a valid email address." };
    }

    const result = await postJson(
      ENDPOINT,
      { authorization: `Bearer ${apiKey}` },
      {
        from: this.config.get("RESEND_FROM_EMAIL", { infer: true }) ?? FALLBACK_FROM,
        to: [message.to],
        subject: message.subject ?? `${APP.name} notification`,
        text: message.body,
        html: toHtml(message.subject, message.body),
      },
    );

    if ("transportError" in result) return transportFailure("Resend", result.transportError);

    if (result.status >= 400) {
      const detail = typeof result.body?.message === "string" ? result.body.message : `HTTP ${result.status}`;
      // DPDP: no address, no subject line, no body.
      this.logger.warn(`Resend refused "${message.template}": ${detail}`);
      return {
        ok: false,
        retryable: isRetryableStatus(result.status),
        reason: `Resend refused the message: ${detail}`,
      };
    }

    const providerRef = typeof result.body?.id === "string" ? result.body.id : "";
    return { ok: true, providerRef: providerRef || `resend:${Date.now()}` };
  }
}

export function isEmailAddress(value: string): boolean {
  // Deliberately loose. The authoritative test of an address is whether mail
  // arrives at it; a strict regex here only rejects valid addresses that happen
  // to be unusual, and Resend will tell us about the rest.
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value.trim());
}

/**
 * The plain-text body, wrapped for mail clients that prefer HTML.
 *
 * No images, no external stylesheet, no tracking pixel: municipal mail should
 * render identically in Outlook 2016 and in a screen reader, and a citizen's
 * receipt is not a marketing opportunity.
 */
function toHtml(subject: string | undefined, body: string): string {
  const lines = body.split("\n").map(escapeHtml);
  return [
    `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:560px">`,
    subject ? `<h2 style="font-size:17px;margin:0 0 12px">${escapeHtml(subject)}</h2>` : "",
    `<div>${lines.join("<br>")}</div>`,
    `<hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0">`,
    `<p style="font-size:12px;color:#666;margin:0">${escapeHtml(APP.fullName)} · This mailbox is not monitored.</p>`,
    `</div>`,
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
