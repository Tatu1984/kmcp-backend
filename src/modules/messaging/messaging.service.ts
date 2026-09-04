import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationChannel, PaymentStatus, Prisma } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { skipTake } from "@/common/dto/pagination.dto";
import { SYSTEM_ROLES } from "@/common/rbac/permissions";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type { Env } from "@/config/env.config";

import { ProviderRegistry } from "./providers/provider.registry";
import {
  DELIVERABLE_CHANNELS,
  isDeliverableChannel,
  type DeliverableChannel,
} from "./providers/provider.types";
import { render, type LinkContext } from "./templates/message-templates";
import type {
  DeliveryQueryDto,
  EmailReportDto,
  SendAnnouncementDto,
  SendPassDto,
  SendReceiptDto,
} from "./dto/messaging.dto";

type Ctx = { ip?: string; requestId?: string };

/** Status strings the `Notification.status` column carries, per the schema. */
const STATUS = {
  queued: "QUEUED",
  sent: "SENT",
  failed: "FAILED",
} as const;

/** Who a message is for. `userId` is null when nobody is on file for it. */
export interface Recipient {
  userId: string | null;
  name: string;
  phone?: string | null;
  email?: string | null;
}

/** One delivery attempt, as the portal and the delivery log show it. */
export interface DeliveryView {
  id: string;
  template: string;
  channel: NotificationChannel;
  status: string;
  /** Masked. See `mask()` — the full address is never returned by this API. */
  recipient: string;
  recipientUserId: string;
  title: string;
  providerRef?: string;
  failureReason?: string;
  sentAt?: Date;
  createdAt: Date;
}

export interface DispatchSummary {
  requested: number;
  sent: number;
  failed: number;
  /** Channels the caller asked for that this deployment holds no credentials for. */
  unconfiguredChannels: DeliverableChannel[];
  deliveries: DeliveryView[];
}

/**
 * Outbound messaging: SMS, WhatsApp and email.
 *
 * The division of labour with NotificationsService is deliberate. That service
 * owns the portal's own bell — IN_APP rows, read by the person they belong to.
 * This one owns everything that leaves the building. Both write to the same
 * `Notification` table, which is why it is worth being explicit about what the
 * shared table buys: one place answers "was this receipt actually sent, and
 * when", for every channel, with the provider's own reference against it.
 *
 * Three rules run through everything below.
 *
 * **A failed send never fails the business.** Every public method here either
 * returns a summary of what happened or, for the on-demand routes, refuses
 * before anything is sent. Nothing throws mid-dispatch, so a caller that
 * triggered this from inside a workflow cannot have its transaction rolled back
 * by a provider having a bad afternoon.
 *
 * **A message that could not be sent is visible.** There is no path that drops
 * one. An unconfigured provider, a citizen with no phone number, a rejected
 * sender id — each becomes a FAILED row carrying the reason, and each is
 * counted in the summary the operator sees.
 *
 * **DPDP.** Phone numbers, email addresses, plate numbers and message bodies
 * pass through here. None of them appear in a log line at info level; delivery
 * rows store a masked address, not the real one; and the audit entry records
 * how many messages went out on which template, never their contents.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly providers: ProviderRegistry,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ status

  /**
   * Which channels this deployment can send on, and who provides them.
   *
   * The portal reads this to decide whether to offer "By WhatsApp" at all,
   * which is a better experience than offering it and reporting a failure the
   * operator can do nothing about.
   */
  channelStatus(): { channel: DeliverableChannel; provider: string; configured: boolean }[] {
    return DELIVERABLE_CHANNELS.map((channel) => {
      const provider = this.providers.provider(channel);
      return { channel, provider: provider.name, configured: provider.isConfigured() };
    });
  }

  // ------------------------------------------------------------ the write side

  /**
   * The entry point for other modules: one event, one recipient, one or more
   * channels. Never throws, ever — a caller inside a transaction can await this
   * without wrapping it, which is the whole point.
   */
  async dispatch(input: {
    recipientUserId: string;
    template: string;
    payload: unknown;
    channels: DeliverableChannel[];
  }): Promise<DispatchSummary> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: input.recipientUserId },
        select: { id: true, name: true, phone: true, email: true },
      });
      if (!user) return empty(input.channels);

      return await this.deliver(
        { userId: user.id, name: user.name, phone: user.phone, email: user.email },
        input.template,
        input.payload,
        input.channels,
        input.recipientUserId,
      );
    } catch (error) {
      // Belt and braces on top of the adapters' own no-throw contract. An alert
      // nobody received is a lesser fault than a workflow that rolled back
      // because of one — the same rule NotificationsService.raise follows.
      this.logger.error(`Dispatch of "${input.template}" failed outright: ${String(error)}`);
      return empty(input.channels);
    }
  }

  /** Re-send a receipt for one or more payments, or for the sessions that paid. */
  async sendReceipts(dto: SendReceiptDto, actor: AuthenticatedUser, ctx: Ctx): Promise<DispatchSummary> {
    const payments = await this.prisma.payment.findMany({
      where: {
        OR: [
          ...(dto.paymentIds?.length ? [{ id: { in: dto.paymentIds } }] : []),
          ...(dto.sessionIds?.length ? [{ sessionId: { in: dto.sessionIds } }] : []),
        ],
        // A receipt only exists for money that was actually taken. Offering to
        // re-send one for a pending or failed payment would be issuing a
        // document for a transaction that has not happened.
        status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
      },
      select: {
        id: true,
        amount: true,
        mode: true,
        paidAt: true,
        createdAt: true,
        receipt: { select: { id: true, number: true, sentChannels: true } },
        pass: { select: { user: CONTACT } },
        session: {
          select: {
            code: true,
            plateNumber: true,
            zone: { select: { name: true } },
            vehicle: { select: { owner: CONTACT } },
          },
        },
      },
    });

    if (payments.length === 0) throw AppException.notFound("payment with a receipt");

    const channels = asChannels(dto.channels);
    const summaries: DispatchSummary[] = [];
    const deliveredReceipts = new Map<string, { existing: string[]; added: Set<string> }>();

    for (const payment of payments) {
      // No receipt row yet means nothing was ever issued. Rather than inventing
      // a number here — receipt numbering is PaymentsService's job and a number
      // appearing twice is an audit finding — the payment is skipped and said so.
      if (!payment.receipt) {
        summaries.push(
          this.refuse(channels, "No receipt has been issued for this payment yet."),
        );
        continue;
      }

      const recipient = toRecipient(payment.session?.vehicle.owner ?? payment.pass?.user ?? null);
      const summary = await this.deliver(
        recipient,
        "receipt.issued",
        {
          receiptNumber: payment.receipt.number,
          amount: payment.amount,
          plateNumber: payment.session?.plateNumber ?? "—",
          zoneName: payment.session?.zone.name ?? "—",
          paidAt: payment.paidAt ?? payment.createdAt,
          mode: humanise(payment.mode),
          sessionCode: payment.session?.code,
        },
        channels,
        actor.id,
      );
      summaries.push(summary);

      const landed = summary.deliveries.filter((d) => d.status === STATUS.sent).map((d) => channelTag(d.channel));
      if (landed.length > 0) {
        const entry = deliveredReceipts.get(payment.receipt.id) ?? {
          existing: payment.receipt.sentChannels,
          added: new Set<string>(),
        };
        landed.forEach((tag) => entry.added.add(tag));
        deliveredReceipts.set(payment.receipt.id, entry);
      }
    }

    // `Receipt.sentChannels` is the copy an auditor reads next to the receipt
    // itself, so it is kept in step with the delivery rows rather than left to
    // drift into a second, quieter version of the truth.
    for (const [receiptId, entry] of deliveredReceipts) {
      await this.prisma.receipt
        .update({
          where: { id: receiptId },
          data: { sentChannels: [...new Set([...entry.existing, ...entry.added])] },
        })
        .catch((error: unknown) => {
          this.logger.warn(`Receipt ${receiptId} sentChannels not updated: ${String(error)}`);
        });
    }

    const combined = combine(summaries);
    await this.recordAudit(actor, ctx, "MESSAGE_RECEIPT_SEND", "Payment", payments.map((p) => p.id), combined);
    return combined;
  }

  /** Send a pass to its holder, or prompt them to renew it. */
  async sendPasses(dto: SendPassDto, actor: AuthenticatedUser, ctx: Ctx): Promise<DispatchSummary> {
    const passes = await this.prisma.pass.findMany({
      where: { id: { in: dto.passIds } },
      select: {
        id: true,
        qrCode: true,
        validFrom: true,
        validTo: true,
        user: CONTACT,
        vehicle: { select: { plateNumber: true } },
        plan: { select: { name: true, price: true } },
      },
    });
    if (passes.length === 0) throw AppException.notFound("pass");

    const channels = asChannels(dto.channels);
    const now = Date.now();
    const summaries: DispatchSummary[] = [];

    for (const pass of passes) {
      const payload =
        dto.kind === "renewal"
          ? {
              holderName: pass.user.name,
              planName: pass.plan.name,
              plateNumber: pass.vehicle.plateNumber,
              validTo: pass.validTo,
              price: pass.plan.price,
              // Rounded up, and floored at zero: "expires in 0 days" reads as
              // today, and a lapsed pass says so outright rather than counting
              // backwards at the holder.
              daysLeft: Math.max(0, Math.ceil((pass.validTo.getTime() - now) / 86_400_000)),
            }
          : {
              holderName: pass.user.name,
              planName: pass.plan.name,
              plateNumber: pass.vehicle.plateNumber,
              validFrom: pass.validFrom,
              validTo: pass.validTo,
              passCode: pass.qrCode,
            };

      summaries.push(
        await this.deliver(
          toRecipient(pass.user),
          dto.kind === "renewal" ? "pass.renewal" : "pass.issued",
          payload,
          channels,
          actor.id,
        ),
      );
    }

    const combined = combine(summaries);
    await this.recordAudit(
      actor,
      ctx,
      dto.kind === "renewal" ? "MESSAGE_PASS_RENEWAL" : "MESSAGE_PASS_SEND",
      "Pass",
      passes.map((p) => p.id),
      combined,
    );
    return combined;
  }

  /** An officer's own words, to a hand-picked selection of citizens. */
  async sendAnnouncement(
    dto: SendAnnouncementDto,
    actor: AuthenticatedUser,
    ctx: Ctx,
  ): Promise<DispatchSummary> {
    const citizens = await this.prisma.user.findMany({
      // Scoped to the CITIZEN role on purpose: this route exists to reach the
      // public, and an officer must not be able to use it to message staff.
      where: { id: { in: dto.citizenIds }, role: SYSTEM_ROLES.CITIZEN, deletedAt: null },
      select: { id: true, name: true, phone: true, email: true },
    });
    if (citizens.length === 0) throw AppException.notFound("citizen");

    const channels = asChannels(dto.channels);
    const summaries: DispatchSummary[] = [];

    for (const citizen of citizens) {
      summaries.push(
        await this.deliver(
          { userId: citizen.id, name: citizen.name, phone: citizen.phone, email: citizen.email },
          "citizen.announcement",
          { title: dto.title, body: dto.body, url: dto.url },
          channels,
          actor.id,
        ),
      );
    }

    const combined = combine(summaries);
    // The announcement's own text is recorded here, unlike every other audit
    // entry in this service: it is the authority's public statement, not a
    // citizen's personal data, and an officer must be answerable for what they
    // sent to several hundred people.
    await this.audit.record({
      actor,
      ...ctx,
      action: "MESSAGE_ANNOUNCEMENT",
      entity: "User",
      entityId: `${citizens.length} citizens`,
      after: {
        title: dto.title,
        body: dto.body,
        channels,
        sent: combined.sent,
        failed: combined.failed,
      },
    });
    return combined;
  }

  /**
   * Emails a finished report to the officer who ran it — and only to them. The
   * recipient is the authenticated account, never a field on the request.
   */
  async emailReport(dto: EmailReportDto, actor: AuthenticatedUser, ctx: Ctx): Promise<DispatchSummary> {
    const me = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { id: true, name: true, phone: true, email: true },
    });
    if (!me) throw AppException.notFound("account");

    const summary = await this.deliver(
      { userId: me.id, name: me.name, phone: me.phone, email: me.email },
      "report.ready",
      {
        reportName: dto.reportName,
        format: dto.format,
        generatedAt: new Date(),
        rangeLabel: dto.rangeLabel,
        rowCount: dto.rowCount,
        url: dto.url,
      },
      [NotificationChannel.EMAIL],
      actor.id,
    );

    await this.recordAudit(actor, ctx, "MESSAGE_REPORT_EMAIL", "Report", [dto.reportName], summary);
    return summary;
  }

  // ------------------------------------------------------------- the read side

  /** The delivery log. "Was this actually sent, and when." */
  async deliveries(query: DeliveryQueryDto): Promise<Paginated<DeliveryView>> {
    const where: Prisma.NotificationWhereInput = {
      // IN_APP rows belong to the bell, not to this log. Mixing them would make
      // "we sent 4,120 messages last month" a number that includes messages
      // nobody ever sent anywhere.
      channel: query.channel
        ? (query.channel as NotificationChannel)
        : { in: [...DELIVERABLE_CHANNELS] },
      ...(query.status ? { status: query.status } : {}),
      ...(query.template ? { template: query.template } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(query) }),
      this.prisma.notification.count({ where }),
    ]);

    return new Paginated(rows.map(toDeliveryView), query.page, query.pageSize, total);
  }

  async delivery(id: string): Promise<DeliveryView> {
    const row = await this.prisma.notification.findFirst({
      where: { id, channel: { in: [...DELIVERABLE_CHANNELS] } },
    });
    if (!row) throw AppException.notFound("delivery");
    return toDeliveryView(row);
  }

  // ------------------------------------------------------------------ internals

  private links(): LinkContext {
    return { appUrl: this.config.get("PUBLIC_APP_URL", { infer: true }) };
  }

  /**
   * Renders once, then sends and logs per channel.
   *
   * The render happens before the loop, deliberately: every channel is built
   * from one set of facts, so an SMS and an email of this event are the same
   * event. A payload that does not satisfy its template throws here, before any
   * row is written and before any provider is called — a malformed message is
   * caught whole rather than half-sent.
   */
  private async deliver(
    recipient: Recipient,
    template: string,
    payload: unknown,
    channels: DeliverableChannel[],
    fallbackUserId: string,
  ): Promise<DispatchSummary> {
    const rendered = render(template, payload, this.links());
    const deliveries: DeliveryView[] = [];

    for (const channel of channels) {
      const address = channel === NotificationChannel.EMAIL ? recipient.email : recipient.phone;
      const body = channel === NotificationChannel.EMAIL ? rendered.email.body
        : channel === NotificationChannel.WHATSAPP ? rendered.whatsapp
        : rendered.sms;

      const logged: Record<string, unknown> = {
        title: rendered.inApp.title,
        body: rendered.inApp.body,
        ...(rendered.inApp.href ? { href: rendered.inApp.href } : {}),
        // Masked, not the real address. The delivery log is read by auditors
        // and support staff who need to confirm a message went to the right
        // person, not to harvest a contact list.
        to: address ? mask(address) : "—",
        provider: this.providers.provider(channel).name,
        // The template's own payload, kept so the exact message can be
        // re-rendered from this row alone months later — which is what makes
        // "what did we actually send them?" an answerable question.
        data: payload,
      };

      // The row is written QUEUED first and updated with the outcome, so a
      // process that dies mid-send leaves evidence that a send was attempted
      // rather than no trace at all.
      const row = await this.prisma.notification.create({
        data: {
          // Schema requires an owner. When nobody is on file the row belongs to
          // the operator who ordered the send — they are the accountable party,
          // and a non-IN_APP row never surfaces in anybody's bell.
          userId: recipient.userId ?? fallbackUserId,
          channel,
          template,
          status: STATUS.queued,
          payload: logged as Prisma.InputJsonValue,
        },
      });

      if (!address) {
        deliveries.push(
          await this.close(row.id, logged, {
            ok: false,
            retryable: false,
            reason:
              channel === NotificationChannel.EMAIL
                ? "No email address on file for this person."
                : "No mobile number on file for this person.",
          }),
        );
        continue;
      }

      const outcome = await this.providers.send(channel, { to: address, subject: rendered.email.subject, body, template });
      deliveries.push(await this.close(row.id, logged, outcome));
    }

    return summarise(deliveries, channels, this.unconfigured(channels));
  }

  /** Writes the outcome onto the queued row and returns it as the API sees it. */
  private async close(
    id: string,
    payload: Record<string, unknown>,
    outcome: { ok: true; providerRef: string } | { ok: false; reason: string; retryable: boolean },
  ): Promise<DeliveryView> {
    const row = await this.prisma.notification.update({
      where: { id },
      data: outcome.ok
        ? { status: STATUS.sent, providerRef: outcome.providerRef, sentAt: new Date() }
        : {
            status: STATUS.failed,
            payload: { ...payload, error: outcome.reason } as Prisma.InputJsonValue,
          },
    });
    return toDeliveryView(row);
  }

  /** A refusal that never reached a provider, shaped like a dispatch summary. */
  private refuse(channels: DeliverableChannel[], reason: string): DispatchSummary {
    return {
      requested: channels.length,
      sent: 0,
      failed: channels.length,
      unconfiguredChannels: this.unconfigured(channels),
      deliveries: channels.map((channel) => ({
        id: "",
        template: "",
        channel,
        status: STATUS.failed,
        recipient: "—",
        recipientUserId: "",
        title: reason,
        failureReason: reason,
        createdAt: new Date(),
      })),
    };
  }

  private unconfigured(channels: DeliverableChannel[]): DeliverableChannel[] {
    return channels.filter((channel) => !this.providers.provider(channel).isConfigured());
  }

  /**
   * One audit entry per request, not per message.
   *
   * A bulk send of two hundred renewal reminders is one act by one officer; two
   * hundred audit rows would bury the acts that matter. Counts and target ids
   * only — never a phone number, an address or a message body.
   */
  private async recordAudit(
    actor: AuthenticatedUser,
    ctx: Ctx,
    action: string,
    entity: string,
    ids: string[],
    summary: DispatchSummary,
  ): Promise<void> {
    await this.audit.record({
      actor,
      ...ctx,
      action,
      entity,
      entityId: ids.length === 1 ? ids[0] : `${ids.length} records`,
      after: {
        ids: ids.slice(0, 50),
        requested: summary.requested,
        sent: summary.sent,
        failed: summary.failed,
        unconfiguredChannels: summary.unconfiguredChannels,
      },
    });
  }
}

// -------------------------------------------------------------------- helpers

/** The contact fields every recipient lookup needs, in one place. */
const CONTACT = { select: { id: true, name: true, phone: true, email: true } } as const;

function toRecipient(
  user: { id: string; name: string; phone: string | null; email: string | null } | null,
): Recipient {
  // A session belongs to a *plate*, and a plate belongs to a person only once
  // they claim it in the app. A walk-up payer therefore genuinely has nobody on
  // file, and saying so is the honest outcome — not a guess at whose car it is.
  if (!user) return { userId: null, name: "Unclaimed vehicle", phone: null, email: null };
  return { userId: user.id, name: user.name, phone: user.phone, email: user.email };
}

function asChannels(values: string[]): DeliverableChannel[] {
  return values.filter(isDeliverableChannel);
}

function summarise(
  deliveries: DeliveryView[],
  channels: DeliverableChannel[],
  unconfiguredChannels: DeliverableChannel[],
): DispatchSummary {
  return {
    requested: channels.length,
    sent: deliveries.filter((d) => d.status === STATUS.sent).length,
    failed: deliveries.filter((d) => d.status === STATUS.failed).length,
    unconfiguredChannels,
    deliveries,
  };
}

function combine(summaries: DispatchSummary[]): DispatchSummary {
  return {
    requested: summaries.reduce((n, s) => n + s.requested, 0),
    sent: summaries.reduce((n, s) => n + s.sent, 0),
    failed: summaries.reduce((n, s) => n + s.failed, 0),
    unconfiguredChannels: summaries[0]?.unconfiguredChannels ?? [],
    // Capped: a two-hundred-recipient send would otherwise return a response
    // larger than the screen that asked for it can use. The counts above are
    // the answer; the rows are a sample, and the delivery log has them all.
    deliveries: summaries.flatMap((s) => s.deliveries).slice(0, 50),
  };
}

function empty(channels: DeliverableChannel[]): DispatchSummary {
  return { requested: channels.length, sent: 0, failed: channels.length, unconfiguredChannels: [], deliveries: [] };
}

function toDeliveryView(row: {
  id: string;
  template: string;
  channel: NotificationChannel;
  status: string;
  providerRef: string | null;
  payload: Prisma.JsonValue;
  sentAt: Date | null;
  createdAt: Date;
  userId: string;
}): DeliveryView {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    template: row.template,
    channel: row.channel,
    status: row.status,
    recipient: typeof payload.to === "string" ? payload.to : "—",
    recipientUserId: row.userId,
    title: typeof payload.title === "string" ? payload.title : row.template,
    ...(row.providerRef ? { providerRef: row.providerRef } : {}),
    ...(typeof payload.error === "string" ? { failureReason: payload.error } : {}),
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    createdAt: row.createdAt,
  };
}

/**
 * Enough of an address to recognise, not enough to use.
 *
 * An auditor confirming "the receipt went to the number on the account" can do
 * that from the last four digits. Nobody can dial them.
 */
export function mask(value: string): string {
  const at = value.indexOf("@");
  if (at > 0) {
    const local = value.slice(0, at);
    const head = local.slice(0, 1);
    return `${head}${"•".repeat(Math.max(2, local.length - 1))}${value.slice(at)}`;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "•".repeat(digits.length || 3);
  return `${"•".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/** `UPI_QR` -> `UPI QR`. The mode as a payer would say it, not as we store it. */
function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

/** `Receipt.sentChannels` holds lower-case tags: sms, whatsapp, email. */
function channelTag(channel: NotificationChannel): string {
  return channel.toLowerCase();
}
