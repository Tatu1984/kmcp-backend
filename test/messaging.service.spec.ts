import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationChannel, PaymentStatus } from "@prisma/client";

import { MessagingService, mask } from "../src/modules/messaging/messaging.service";
import { ProviderRegistry } from "../src/modules/messaging/providers/provider.registry";
import { Msg91SmsProvider } from "../src/modules/messaging/providers/msg91-sms.provider";
import { WhatsAppCloudProvider } from "../src/modules/messaging/providers/whatsapp-cloud.provider";
import { ResendEmailProvider } from "../src/modules/messaging/providers/resend-email.provider";

/**
 * The delivery log, and what happens on a deployment holding no credentials.
 *
 * This is the case CI and the demo build actually run in, so it is the case
 * most worth pinning down: nothing is sent, nothing throws, and every message
 * that could not go out leaves a FAILED row saying why. A message that vanished
 * quietly would be worse than one that was never attempted, because nobody
 * would know to attempt it again.
 */

const OFFICER = {
  id: "usr_officer",
  role: "ADMIN",
  name: "R. Banerjee",
  isZoneScoped: false,
  zoneIds: [],
  sessionId: "ses_1",
};

const CITIZEN = { id: "usr_citizen", name: "Ruma Sen", phone: "9876543210", email: "ruma@example.com" };

const PAYMENT = {
  id: "pay_1",
  amount: 12000,
  mode: "UPI_QR",
  paidAt: new Date("2026-03-14T09:45:00.000Z"),
  createdAt: new Date("2026-03-14T09:45:00.000Z"),
  receipt: { id: "rcp_1", number: "KMCP-R-000418", sentChannels: [] as string[] },
  pass: null,
  session: {
    code: "KMCP-8F3K2Q",
    plateNumber: "WB02AB1234",
    zone: { name: "Esplanade East" },
    vehicle: { owner: CITIZEN },
  },
};

/** Nothing is set, which is exactly how a laptop and a CI runner are configured. */
const noCredentials = { get: () => undefined } as never;

function makeService(overrides: { payments?: unknown[]; notifications?: unknown[] } = {}) {
  let seq = 0;
  const rows = new Map<string, Record<string, unknown>>();

  const prisma = {
    payment: { findMany: vi.fn().mockResolvedValue(overrides.payments ?? [PAYMENT]) },
    receipt: { update: vi.fn().mockResolvedValue({}) },
    pass: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ ...CITIZEN }),
      findMany: vi.fn().mockResolvedValue([CITIZEN]),
    },
    notification: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `ntf_${++seq}`, providerRef: null, sentAt: null, createdAt: new Date(), ...data };
        rows.set(row.id, row);
        return Promise.resolve(row);
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...rows.get(where.id), ...data };
        rows.set(where.id, row);
        return Promise.resolve(row);
      }),
      findMany: vi.fn().mockResolvedValue(overrides.notifications ?? []),
      findFirst: vi.fn().mockResolvedValue((overrides.notifications ?? [])[0] ?? null),
      count: vi.fn().mockResolvedValue((overrides.notifications ?? []).length),
    },
  };

  const registry = new ProviderRegistry(
    new Msg91SmsProvider(noCredentials),
    new WhatsAppCloudProvider(noCredentials),
    new ResendEmailProvider(noCredentials),
  );
  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  return {
    service: new MessagingService(prisma as never, noCredentials, registry, audit as never),
    prisma,
    audit,
    rows,
  };
}

describe("sending with no provider credentials", () => {
  it("reports which channels the deployment cannot send on", () => {
    const { service } = makeService();
    expect(service.channelStatus()).toEqual([
      { channel: "SMS", provider: "msg91", configured: false },
      { channel: "WHATSAPP", provider: "whatsapp-cloud", configured: false },
      { channel: "EMAIL", provider: "resend", configured: false },
    ]);
  });

  it("records the intent as a FAILED delivery instead of dropping it", async () => {
    const { service, prisma } = makeService();

    const summary = await service.sendReceipts(
      { paymentIds: ["pay_1"], channels: ["SMS", "EMAIL"] },
      OFFICER as never,
      {},
    );

    expect(summary.sent).toBe(0);
    expect(summary.failed).toBe(2);
    expect(summary.unconfiguredChannels).toEqual(["SMS", "EMAIL"]);

    // One row per recipient per channel, written QUEUED then closed FAILED.
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
    for (const call of prisma.notification.create.mock.calls) {
      expect((call[0] as { data: { status: string } }).data.status).toBe("QUEUED");
    }
    for (const delivery of summary.deliveries) {
      expect(delivery.status).toBe("FAILED");
      expect(delivery.failureReason).toMatch(/not configured on this deployment/);
      expect(delivery.providerRef).toBeUndefined();
    }
  });

  it("names the missing variable, so the reason is actionable", async () => {
    const { service } = makeService();
    const summary = await service.sendReceipts(
      { paymentIds: ["pay_1"], channels: ["SMS"] },
      OFFICER as never,
      {},
    );
    expect(summary.deliveries[0].failureReason).toContain("MSG91_AUTH_KEY");
  });

  it("leaves the receipt's own sentChannels untouched", async () => {
    const { service, prisma } = makeService();
    await service.sendReceipts({ paymentIds: ["pay_1"], channels: ["SMS"] }, OFFICER as never, {});
    // Nothing left the building, so nothing is recorded as having been sent.
    expect(prisma.receipt.update).not.toHaveBeenCalled();
  });
});

describe("the delivery row", () => {
  it("stores a masked address, never the real one", async () => {
    const { service, prisma } = makeService();
    await service.sendReceipts({ paymentIds: ["pay_1"], channels: ["SMS", "EMAIL"] }, OFFICER as never, {});

    const written = prisma.notification.create.mock.calls.map(
      (c) => (c[0] as { data: { payload: Record<string, unknown> } }).data.payload,
    );
    const addresses = written.map((p) => String(p.to));
    expect(addresses).toEqual(["••••••3210", "r•••@example.com"]);
    expect(JSON.stringify(written)).not.toContain("9876543210");
    expect(JSON.stringify(written)).not.toContain("ruma@example.com");
  });

  it("keeps the payload, so the message can be re-rendered from the row alone", async () => {
    const { service, prisma } = makeService();
    await service.sendReceipts({ paymentIds: ["pay_1"], channels: ["SMS"] }, OFFICER as never, {});

    const payload = (prisma.notification.create.mock.calls[0][0] as { data: { payload: Record<string, unknown> } })
      .data.payload;
    expect((payload.data as { receiptNumber: string }).receiptNumber).toBe("KMCP-R-000418");
    expect(payload.title).toContain("KMCP-R-000418");
  });

  it("belongs to the recipient when there is one", async () => {
    const { service, prisma } = makeService();
    await service.sendReceipts({ paymentIds: ["pay_1"], channels: ["SMS"] }, OFFICER as never, {});
    expect((prisma.notification.create.mock.calls[0][0] as { data: { userId: string } }).data.userId).toBe(
      "usr_citizen",
    );
  });

  it("belongs to the operator when nobody is on file for the plate", async () => {
    // A session belongs to a plate, and a plate belongs to a person only once
    // they claim it in the app. The log row still has to belong to someone, and
    // the accountable party is whoever ordered the send.
    const unclaimed = { ...PAYMENT, session: { ...PAYMENT.session, vehicle: { owner: null } } };
    const { service, prisma } = makeService({ payments: [unclaimed] });

    const summary = await service.sendReceipts(
      { paymentIds: ["pay_1"], channels: ["SMS"] },
      OFFICER as never,
      {},
    );

    expect((prisma.notification.create.mock.calls[0][0] as { data: { userId: string } }).data.userId).toBe(
      "usr_officer",
    );
    expect(summary.deliveries[0].failureReason).toBe("No mobile number on file for this person.");
  });

  it("is never written on the IN_APP channel — that belongs to the bell", async () => {
    const { service, prisma } = makeService();
    await service.sendReceipts(
      { paymentIds: ["pay_1"], channels: ["SMS", "WHATSAPP", "EMAIL"] },
      OFFICER as never,
      {},
    );
    const channels = prisma.notification.create.mock.calls.map(
      (c) => (c[0] as { data: { channel: string } }).data.channel,
    );
    expect(channels).not.toContain(NotificationChannel.IN_APP);
  });
});

describe("refusals that never reach a provider", () => {
  it("will not send a receipt for a payment that has none", async () => {
    const { service, prisma } = makeService({ payments: [{ ...PAYMENT, receipt: null }] });

    const summary = await service.sendReceipts(
      { paymentIds: ["pay_1"], channels: ["SMS"] },
      OFFICER as never,
      {},
    );

    expect(summary.failed).toBe(1);
    expect(summary.deliveries[0].failureReason).toContain("No receipt has been issued");
    // Issuing a number is PaymentsService's job; a number appearing twice is an
    // audit finding, so nothing was created here.
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it("only considers payments where money was actually taken", async () => {
    const { service, prisma } = makeService();
    await service.sendReceipts({ sessionIds: ["ses_9"], channels: ["SMS"] }, OFFICER as never, {});

    const where = (prisma.payment.findMany.mock.calls[0][0] as { where: { status: { in: string[] } } }).where;
    expect(where.status.in).toEqual([PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED]);
  });
});

describe("dispatch, for other modules", () => {
  it("never throws, even when the database is unavailable", async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockRejectedValue(new Error("connection terminated"));

    // The rule NotificationsService.raise already documents: an alert nobody
    // received is a lesser fault than a workflow that rolled back over one.
    await expect(
      service.dispatch({
        recipientUserId: "usr_citizen",
        template: "session.overstay",
        payload: {},
        channels: [NotificationChannel.SMS],
      }),
    ).resolves.toMatchObject({ sent: 0, failed: 1 });
  });

  it("never throws on a payload that does not match its template", async () => {
    const { service } = makeService();
    await expect(
      service.dispatch({
        recipientUserId: "usr_citizen",
        template: "session.overstay",
        payload: { nothing: "useful" },
        channels: [NotificationChannel.SMS],
      }),
    ).resolves.toMatchObject({ sent: 0, failed: 1 });
  });
});

describe("the audit trail", () => {
  it("records the act and its counts, never the message or the recipients", async () => {
    const { service, audit } = makeService();
    await service.sendReceipts({ paymentIds: ["pay_1"], channels: ["SMS"] }, OFFICER as never, {});

    const entry = audit.record.mock.calls[0][0] as { action: string; after: Record<string, unknown> };
    expect(entry.action).toBe("MESSAGE_RECEIPT_SEND");
    expect(entry.after).toMatchObject({ requested: 1, sent: 0, failed: 1 });
    expect(JSON.stringify(entry)).not.toContain("9876543210");
    expect(JSON.stringify(entry)).not.toContain("WB02AB1234");
  });
});

describe("the delivery log query", () => {
  it("excludes in-app alerts, which were never sent anywhere", async () => {
    const { service, prisma } = makeService();
    await service.deliveries({ page: 1, pageSize: 25 } as never);

    const where = (prisma.notification.findMany.mock.calls[0][0] as {
      where: { channel: { in: string[] } };
    }).where;
    expect(where.channel.in).toEqual(["SMS", "WHATSAPP", "EMAIL"]);
  });
});

describe("masking", () => {
  it("shows enough to recognise a number and not enough to dial it", () => {
    expect(mask("9876543210")).toBe("••••••3210");
    expect(mask("+91 98765 43210")).toBe("••••••••3210");
  });

  it("keeps an email's domain, which is how support recognises an account", () => {
    expect(mask("ruma@example.com")).toBe("r•••@example.com");
    expect(mask("a@b.com")).toBe("a••@b.com");
  });
});
