import * as Sentry from "@sentry/nestjs";
import { redactUrl, scrubBreadcrumb, scrubEvent } from "./scrub";

/**
 * Error reporting for the API.
 *
 * Until this existed, a production failure was visible only to whoever thought
 * to open the platform logs — which, on a serverless host, means noticing that
 * something is wrong first and going looking second. Nobody was ever told.
 *
 * Two things make this more than an install:
 *
 * Every reported event carries the request's correlation id as a tag. That id
 * is the one `RequestIdMiddleware` assigns, the one the response envelope
 * returns in `meta.requestId`, and the one written against every audit row the
 * request produced. Searching `request_id:<value>` in Sentry and searching the
 * audit trail for the same value therefore land on the same request — which is
 * the difference between "a 500 happened somewhere in settlements" and "this
 * approval, by this officer, at this second, failed here".
 *
 * And every event is stripped of citizen data before it leaves — see `scrub.ts`
 * for exactly which fields and why.
 *
 * With no `SENTRY_DSN` configured this is inert: `initSentry` returns without
 * touching the SDK and `reportException` returns immediately. A local run and
 * the demo deployment need no Sentry account and no extra configuration.
 */

let enabled = false;

/** True once a DSN has been configured and the SDK initialised. */
export const isErrorReportingEnabled = (): boolean => enabled;

/**
 * Starts the SDK. Safe to call more than once and safe to call with nothing
 * configured; returns whether reporting is actually on.
 *
 * Called from `src/instrument.ts`, which `main.ts` imports before anything
 * else, so a failure during bootstrap is already covered.
 */
export function initSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  if (enabled) return true;

  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT ?? env.VERCEL_ENV ?? env.NODE_ENV ?? "development",
    // Vercel sets this on every deployment; it turns a stack trace into a
    // stack trace against a known commit.
    release: env.VERCEL_GIT_COMMIT_SHA,

    /**
     * The SDK's own idea of "personally identifiable information" is IP
     * addresses and headers. Ours is wider and is enforced in `beforeSend`;
     * this switch is the coarse half of the same decision, and off is the only
     * defensible default for a platform holding citizen records.
     */
    sendDefaultPii: false,

    // Errors only. Tracing would sample request spans whose names and
    // attributes carry the very identifiers `beforeSend` exists to remove,
    // and nobody has asked this API for performance data.
    tracesSampleRate: 0,

    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });

  enabled = true;
  return true;
}

/**
 * Waits for queued events to actually leave the process.
 *
 * The SDK batches and sends in the background, which is right for a long-lived
 * server and wrong for a serverless one: Vercel freezes the container the
 * moment the response is finished, and anything still queued is lost — so the
 * 500s that matter most, the ones on an otherwise idle deployment, would be
 * exactly the ones that never arrived. `api/index.js` awaits this after the
 * response has been written, where the delay costs the caller nothing.
 *
 * Never throws: a failure to report must not become a failure to respond.
 */
export async function flushErrorReports(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // The event is lost. Nothing useful is left to do about it here.
  }
}

/** What the exception filter knows about the request that failed. */
export interface ReportContext {
  /** The correlation id. This is the point of the whole exercise. */
  requestId: string;
  /** The stable `error.code` the client was handed. */
  code: string;
  status: number;
  method?: string;
  url?: string;
  /** The authenticated role, when there was one. Never the account's identity. */
  role?: string;
  userId?: string;
}

/**
 * Sends one exception, tagged so it can be found again.
 *
 * `request_id` and `error_code` are tags rather than context because Sentry
 * only indexes tags for search — context is readable but not queryable, and an
 * id you cannot search for is an id you cannot correlate with.
 */
export function reportException(exception: unknown, context: ReportContext): void {
  if (!enabled) return;

  Sentry.withScope((scope) => {
    scope.setTag("request_id", context.requestId);
    scope.setTag("error_code", context.code);
    scope.setTag("http_status", String(context.status));
    if (context.method) scope.setTag("http_method", context.method);
    if (context.role) scope.setTag("role", context.role);
    if (context.userId) scope.setUser({ id: context.userId });
    /**
     * Redacted here rather than in `beforeSend`: this lands in `contexts`,
     * which `scrubEvent` does not walk, and a request URL is one of the two
     * places a plate reliably shows up (`GET /sessions?plate=…`).
     */
    if (context.url) {
      scope.setContext("http", { method: context.method, url: redactUrl(context.url) });
    }
    Sentry.captureException(exception);
  });
}
