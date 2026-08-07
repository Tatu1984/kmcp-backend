import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";

import { AppException } from "@/common/errors/app.exception";
import type { Env } from "@/config/env.config";

/**
 * Razorpay, over its REST API.
 *
 * Deliberately not the `razorpay` npm package. Two ESM-only dependencies have
 * already stopped this API from booting on Vercel, whose bundler cannot require
 * ES modules; an HTTP call and an HMAC need neither. It also keeps the surface
 * we depend on to the four operations we actually use.
 *
 * Every amount crossing this boundary is integer paise, which is what Razorpay
 * expects. There is no floating point anywhere in the money path.
 */

const API = "https://api.razorpay.com/v1";

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string;
}

export interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  status: string;
  method?: string;
  error_description?: string;
}

@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** False on deployments where the authority has not yet supplied keys. */
  get isConfigured(): boolean {
    return Boolean(
      this.config.get("RAZORPAY_KEY_ID", { infer: true }) &&
        this.config.get("RAZORPAY_KEY_SECRET", { infer: true }),
    );
  }

  /** The publishable key. Safe to hand to a browser or a handset. */
  get keyId(): string | undefined {
    return this.config.get("RAZORPAY_KEY_ID", { infer: true });
  }

  private credentials(): { keyId: string; keySecret: string } {
    const keyId = this.config.get("RAZORPAY_KEY_ID", { infer: true });
    const keySecret = this.config.get("RAZORPAY_KEY_SECRET", { infer: true });
    if (!keyId || !keySecret) {
      throw new AppException(
        "SERVICE_UNAVAILABLE",
        [{ field: "gateway", issue: "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set" }],
        "Online payment is not configured on this deployment. Cash can still be collected.",
      );
    }
    return { keyId, keySecret };
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { keyId, keySecret } = this.credentials();
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // The gateway being unreachable is not the caller's fault and must not
      // look like a rejected payment.
      this.logger.error(`Razorpay unreachable: ${String(error)}`);
      throw new AppException(
        "SERVICE_UNAVAILABLE",
        undefined,
        "The payment gateway did not respond. Nothing has been charged — please try again.",
      );
    }

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

    if (!response.ok) {
      const description =
        ((body?.error as Record<string, unknown> | undefined)?.description as string) ??
        "The payment gateway refused the request.";
      this.logger.warn(`Razorpay ${path} -> ${response.status}: ${description}`);
      throw new AppException("SERVICE_UNAVAILABLE", [{ field: "gateway", issue: description }], description);
    }

    return body as T;
  }

  /** `receipt` is our own reference, echoed back on the payment and webhook. */
  createOrder(amountPaise: number, receipt: string, notes: Record<string, string> = {}) {
    return this.call<RazorpayOrder>("/orders", {
      method: "POST",
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt,
        notes,
        // The money is captured by Razorpay as soon as the payer authorises it.
        // A two-step authorise-then-capture would leave a citizen's card held
        // while an attendant decides, which is not a thing anyone wants at a kerb.
        payment_capture: 1,
      }),
    });
  }

  fetchPayment(paymentId: string) {
    return this.call<RazorpayPayment>(`/payments/${paymentId}`);
  }

  refund(paymentId: string, amountPaise: number, notes: Record<string, string> = {}) {
    return this.call<{ id: string; amount: number; status: string }>(`/payments/${paymentId}/refund`, {
      method: "POST",
      body: JSON.stringify({ amount: amountPaise, notes, speed: "normal" }),
    });
  }

  /**
   * Confirms a checkout result returned by the client.
   *
   * The client is not trusted: it hands back an order id, a payment id and a
   * signature, and only the signature — computed with a secret the client has
   * never seen — proves Razorpay actually authorised that payment.
   */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    const { keySecret } = this.credentials();
    const expected = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
    return this.safeEqual(expected, signature);
  }

  /**
   * Confirms a webhook came from Razorpay.
   *
   * Signed over the exact bytes received, which is why the JSON body parser
   * keeps a raw copy — re-serialising the parsed object would change the
   * whitespace and the signature would never match.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
    const secret = this.config.get("RAZORPAY_WEBHOOK_SECRET", { infer: true });
    if (!secret) {
      throw new AppException(
        "SERVICE_UNAVAILABLE",
        [{ field: "webhook", issue: "RAZORPAY_WEBHOOK_SECRET is not set" }],
        "Webhooks are not configured on this deployment.",
      );
    }
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return this.safeEqual(expected, signature);
  }

  /** Constant time. A length or timing leak here is a forgeable signature. */
  private safeEqual(expected: string, actual: string): boolean {
    if (typeof actual !== "string" || actual.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  }
}
