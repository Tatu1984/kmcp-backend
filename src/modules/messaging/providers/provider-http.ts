import type { SendOutcome } from "./provider.types";

/** Long enough for a provider having a slow minute, short enough that an
 *  operator waiting on a "Re-send receipt" click does not think we hung. */
const TIMEOUT_MS = 10_000;

export interface JsonResponse {
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * One JSON POST, with every failure mode already turned into a `SendOutcome`.
 *
 * Adapters call this instead of `fetch` so that the retryable/not-retryable
 * decision is made once, from the transport facts, rather than three times from
 * three slightly different readings of the same HTTP status codes.
 *
 * Deliberately never throws: see the contract on `MessageProvider`.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<JsonResponse | { transportError: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body: parsed };
  } catch (error) {
    // A timeout, a DNS failure or a reset socket. The message may or may not
    // have gone out; we cannot know, so we report it as retryable and let the
    // caller's bounded retry decide. A duplicate SMS is a smaller harm than a
    // receipt that silently never arrived.
    return { transportError: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Turns an HTTP status into a retry decision.
 *
 * 429 and 5xx are the provider's problem and will likely have passed in a
 * second. Everything else in the 4xx range is ours — a bad number, a sender id
 * the operator has not registered, an expired key — and no amount of retrying
 * will change the answer.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** The shape adapters return when the transport itself failed. */
export function transportFailure(provider: string, detail: string): SendOutcome {
  return { ok: false, reason: `${provider} did not respond (${detail})`, retryable: true };
}
