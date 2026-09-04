import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationChannel } from "@prisma/client";

import { Msg91SmsProvider, normaliseIndianMsisdn } from "../src/modules/messaging/providers/msg91-sms.provider";
import { WhatsAppCloudProvider } from "../src/modules/messaging/providers/whatsapp-cloud.provider";
import { ResendEmailProvider, isEmailAddress } from "../src/modules/messaging/providers/resend-email.provider";
import { ProviderRegistry } from "../src/modules/messaging/providers/provider.registry";
import type { MessageProvider, OutboundMessage } from "../src/modules/messaging/providers/provider.types";

/**
 * The provider abstraction.
 *
 * Two properties matter more than any individual adapter, and both are tested
 * here rather than assumed: an adapter with no credentials does nothing and
 * says so, and no adapter ever throws. The first is what lets CI and the demo
 * build run without live provider accounts; the second is what stops a
 * messaging failure from rolling back the business transaction that caused it.
 */

/** A ConfigService stand-in. Anything not listed is genuinely unset. */
const config = (values: Record<string, string> = {}) =>
  ({ get: (key: string) => values[key] }) as never;

const message: OutboundMessage = {
  to: "9876543210",
  subject: "Receipt KMCP-R-1",
  body: "KMCP: Receipt KMCP-R-1 for WB02AB1234. Amount ₹120.00",
  template: "receipt.issued",
};

/** Replaces global fetch and hands back the spy. */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an adapter with no credentials", () => {
  it("reports SMS as unconfigured and never touches the network", async () => {
    const fetchSpy = stubFetch(() => json(200, {}));
    const provider = new Msg91SmsProvider(config());

    expect(provider.isConfigured()).toBe(false);
    const outcome = await provider.send(message);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.unconfigured).toBe(true);
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason).toContain("MSG91_AUTH_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports WhatsApp as unconfigured, naming both variables", async () => {
    const fetchSpy = stubFetch(() => json(200, {}));
    const provider = new WhatsAppCloudProvider(config({ WHATSAPP_TOKEN: "t" }));

    // One of the pair is set, which is not the same as configured.
    expect(provider.isConfigured()).toBe(false);
    const outcome = await provider.send(message);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.unconfigured).toBe(true);
    expect(outcome.reason).toContain("WHATSAPP_PHONE_NUMBER_ID");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports email as unconfigured", async () => {
    const fetchSpy = stubFetch(() => json(200, {}));
    const provider = new ResendEmailProvider(config());

    expect(provider.isConfigured()).toBe(false);
    const outcome = await provider.send({ ...message, to: "citizen@example.com" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.unconfigured).toBe(true);
    expect(outcome.reason).toContain("RESEND_API_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves the registry reporting no usable channels", () => {
    const registry = new ProviderRegistry(
      new Msg91SmsProvider(config()),
      new WhatsAppCloudProvider(config()),
      new ResendEmailProvider(config()),
    );
    expect(registry.configuredChannels()).toEqual([]);
  });

  it("is not retried — there is nothing transient about a missing key", async () => {
    const provider = new Msg91SmsProvider(config());
    const spy = vi.spyOn(provider, "send");
    const registry = new ProviderRegistry(
      provider,
      new WhatsAppCloudProvider(config()),
      new ResendEmailProvider(config()),
    );

    const outcome = await registry.send(NotificationChannel.SMS, message);

    expect(outcome.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("MSG91", () => {
  const configured = config({ MSG91_AUTH_KEY: "key", MSG91_SENDER_ID: "KMCPGN", MSG91_TEMPLATE_ID: "tpl_1" });

  it("sends and returns the provider's own reference", async () => {
    const fetchSpy = stubFetch(() => json(200, { type: "success", request_id: "req_9" }));
    const outcome = await new Msg91SmsProvider(configured).send(message);

    expect(outcome).toEqual({ ok: true, providerRef: "req_9" });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("msg91.com");
    const sent = JSON.parse(String(init.body)) as { recipients: { mobiles: string }[]; template_id: string };
    // Ten digits are assumed Indian and country-coded on the way out.
    expect(sent.recipients[0].mobiles).toBe("919876543210");
    expect(sent.template_id).toBe("tpl_1");
  });

  it("treats a 200 carrying type:error as a refusal, not a send", async () => {
    stubFetch(() => json(200, { type: "error", message: "sender id not registered" }));
    const outcome = await new Msg91SmsProvider(configured).send(message);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason).toContain("sender id not registered");
  });

  it("refuses a number that is not a number, without asking the provider", async () => {
    const fetchSpy = stubFetch(() => json(200, {}));
    const outcome = await new Msg91SmsProvider(configured).send({ ...message, to: "not a phone" });

    expect(outcome.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not throw when the network does", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNRESET")));
    const outcome = await new Msg91SmsProvider(configured).send(message);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    // Unknowable whether it went out, so worth another go.
    expect(outcome.retryable).toBe(true);
  });
});

describe("WhatsApp Cloud", () => {
  const configured = config({ WHATSAPP_PHONE_NUMBER_ID: "1234", WHATSAPP_TOKEN: "tok" });

  it("sends text with link previews off and returns the message id", async () => {
    const fetchSpy = stubFetch(() => json(200, { messages: [{ id: "wamid.X" }] }));
    const outcome = await new WhatsAppCloudProvider(configured).send(message);

    expect(outcome).toEqual({ ok: true, providerRef: "wamid.X" });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { text: { preview_url: boolean } };
    expect(sent.text.preview_url).toBe(false);
  });

  it("surfaces Meta's own reason for a refusal", async () => {
    stubFetch(() => json(400, { error: { message: "Message failed to send because more than 24 hours have passed" } }));
    const outcome = await new WhatsAppCloudProvider(configured).send(message);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toContain("24 hours");
    expect(outcome.retryable).toBe(false);
  });
});

describe("Resend", () => {
  const configured = config({ RESEND_API_KEY: "re_1", RESEND_FROM_EMAIL: "KMCP <no-reply@kmcp.gov.in>" });

  it("sends both a text and an HTML part", async () => {
    const fetchSpy = stubFetch(() => json(200, { id: "email_1" }));
    const outcome = await new ResendEmailProvider(configured).send({ ...message, to: "citizen@example.com" });

    expect(outcome).toEqual({ ok: true, providerRef: "email_1" });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { text: string; html: string; from: string };
    expect(sent.text).toBe(message.body);
    expect(sent.html).toContain("Receipt KMCP-R-1");
    expect(sent.from).toContain("kmcp.gov.in");
  });

  it("refuses a phone number given as an email address", async () => {
    const fetchSpy = stubFetch(() => json(200, {}));
    const outcome = await new ResendEmailProvider(configured).send({ ...message, to: "9876543210" });

    expect(outcome.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("escapes the body into the HTML part", async () => {
    const fetchSpy = stubFetch(() => json(200, { id: "email_2" }));
    await new ResendEmailProvider(configured).send({
      ...message,
      to: "citizen@example.com",
      body: "<script>alert(1)</script>",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { html: string };
    expect(sent.html).not.toContain("<script>");
    expect(sent.html).toContain("&lt;script&gt;");
  });
});

describe("the bounded retry", () => {
  const registry = () =>
    new ProviderRegistry(
      new Msg91SmsProvider(config({ MSG91_AUTH_KEY: "k", MSG91_SENDER_ID: "S" })),
      new WhatsAppCloudProvider(config()),
      new ResendEmailProvider(config()),
    );

  it("stops after three attempts and says it gave up", async () => {
    const fetchSpy = stubFetch(() => json(503, { message: "upstream busy" }));

    const outcome = await registry().send(NotificationChannel.SMS, message);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toContain("gave up after 3 attempts");
  });

  it("stops the moment it succeeds", async () => {
    let calls = 0;
    const fetchSpy = stubFetch(() => {
      calls += 1;
      return calls === 1 ? json(500, {}) : json(200, { type: "success", request_id: "req_2" });
    });

    const outcome = await registry().send(NotificationChannel.SMS, message);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ ok: true, providerRef: "req_2" });
  });

  it("does not retry a refusal the provider will repeat", async () => {
    const fetchSpy = stubFetch(() => json(401, { message: "invalid authkey" }));

    const outcome = await registry().send(NotificationChannel.SMS, message);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
  });
});

describe("channel selection", () => {
  it("hands each channel to the adapter that owns it", () => {
    const registry = new ProviderRegistry(
      new Msg91SmsProvider(config()),
      new WhatsAppCloudProvider(config()),
      new ResendEmailProvider(config()),
    );

    expect(registry.provider(NotificationChannel.SMS).name).toBe("msg91");
    expect(registry.provider(NotificationChannel.WHATSAPP).name).toBe("whatsapp-cloud");
    expect(registry.provider(NotificationChannel.EMAIL).name).toBe("resend");
  });

  it("accepts any implementation of the interface, not just the three shipped", async () => {
    // The point of the abstraction: swapping MSG91 is a one-file change, and
    // nothing outside providers/ knows which vendor is behind a channel.
    const fake: MessageProvider = {
      channel: NotificationChannel.SMS,
      name: "fake",
      isConfigured: () => true,
      send: async () => ({ ok: true, providerRef: "fake_1" }),
    };
    const registry = new ProviderRegistry(
      fake as Msg91SmsProvider,
      new WhatsAppCloudProvider(config()),
      new ResendEmailProvider(config()),
    );

    expect(registry.configuredChannels()).toEqual([NotificationChannel.SMS]);
    await expect(registry.send(NotificationChannel.SMS, message)).resolves.toEqual({
      ok: true,
      providerRef: "fake_1",
    });
  });
});

describe("address normalisation", () => {
  it("country-codes a bare Indian mobile and leaves a coded one alone", () => {
    expect(normaliseIndianMsisdn("9876543210")).toBe("919876543210");
    expect(normaliseIndianMsisdn("+91 98765 43210")).toBe("919876543210");
    expect(normaliseIndianMsisdn("919876543210")).toBe("919876543210");
  });

  it("rejects what is not a number at all", () => {
    expect(normaliseIndianMsisdn("12345")).toBeNull();
    expect(normaliseIndianMsisdn("")).toBeNull();
  });

  it("accepts an ordinary address and rejects a plate number", () => {
    expect(isEmailAddress("citizen@example.com")).toBe(true);
    expect(isEmailAddress("WB02AB1234")).toBe(false);
  });
});
