import { Injectable, Logger } from "@nestjs/common";

import { Msg91SmsProvider } from "./msg91-sms.provider";
import { ResendEmailProvider } from "./resend-email.provider";
import { WhatsAppCloudProvider } from "./whatsapp-cloud.provider";
import {
  DELIVERABLE_CHANNELS,
  type DeliverableChannel,
  type MessageProvider,
  type OutboundMessage,
  type SendOutcome,
} from "./provider.types";

/**
 * How many times one message is attempted, in total, including the first try.
 *
 * Three, and not configurable. A larger number is not a better outcome: this
 * runs inside the request an operator is waiting on, and the honest answer to
 * "the provider has been down for ten seconds" is to record the failure and let
 * them click again, not to hold the connection open hoping.
 */
const MAX_ATTEMPTS = 3;

/** 400ms, then 1200ms. Tripling, from a base short enough to be worth waiting. */
const BASE_BACKOFF_MS = 400;

/**
 * Picks the adapter for a channel, and is the only place a send is retried.
 *
 * Retrying is a transport concern, so it lives with the transports rather than
 * in the service that decides *what* to say. That separation is what keeps the
 * retry bounded: there is no queue, no persisted backlog and no background
 * worker — three attempts inside one request, then a recorded failure. An
 * unbounded queue on a serverless deployment is a queue that never drains,
 * because the container is gone the moment the response is written.
 */
@Injectable()
export class ProviderRegistry {
  private readonly logger = new Logger(ProviderRegistry.name);
  private readonly byChannel: Map<DeliverableChannel, MessageProvider>;

  constructor(
    sms: Msg91SmsProvider,
    whatsapp: WhatsAppCloudProvider,
    email: ResendEmailProvider,
  ) {
    this.byChannel = new Map<DeliverableChannel, MessageProvider>([
      [sms.channel, sms],
      [whatsapp.channel, whatsapp],
      [email.channel, email],
    ]);
  }

  provider(channel: DeliverableChannel): MessageProvider {
    const provider = this.byChannel.get(channel);
    // Unreachable while DeliverableChannel and the constructor agree, but the
    // map is built at runtime and a future fourth channel would land here
    // rather than sending nothing and reporting success.
    if (!provider) throw new Error(`No message provider is registered for ${channel}`);
    return provider;
  }

  /**
   * Which channels this deployment can actually send on.
   *
   * Read by the health surface and by the send routes, so a portal control can
   * be told "this deployment has no WhatsApp credentials" up front instead of
   * discovering it one failed delivery at a time.
   */
  configuredChannels(): DeliverableChannel[] {
    return DELIVERABLE_CHANNELS.filter((channel) => this.provider(channel).isConfigured());
  }

  /**
   * Sends one message, retrying only what is worth retrying.
   *
   * Never throws — the contract on `MessageProvider` guarantees the adapters do
   * not, and this adds no new failure mode of its own. A caller can treat the
   * returned outcome as the whole truth.
   */
  async send(channel: DeliverableChannel, message: OutboundMessage): Promise<SendOutcome> {
    const provider = this.provider(channel);
    let last: SendOutcome = { ok: false, retryable: false, reason: "No attempt was made." };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      last = await provider.send(message);
      if (last.ok || !last.retryable) return last;

      if (attempt < MAX_ATTEMPTS) {
        // Template key and attempt number only — never the recipient or body.
        this.logger.warn(
          `${provider.name} attempt ${attempt}/${MAX_ATTEMPTS} for "${message.template}" failed: ${last.reason}`,
        );
        await delay(BASE_BACKOFF_MS * 3 ** (attempt - 1));
      }
    }

    return {
      ...last,
      reason: `${last.reason} (gave up after ${MAX_ATTEMPTS} attempts)`,
    };
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
