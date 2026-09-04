/**
 * Vercel serverless entry point.
 *
 * Deliberately plain JavaScript that consumes `dist/`, not TypeScript that
 * imports `src/`.
 *
 * Vercel's Node builder compiles TypeScript with esbuild, and esbuild does not
 * support `emitDecoratorMetadata`. NestJS resolves constructor injection from
 * the `design:paramtypes` metadata that flag emits, so compiling the app with
 * esbuild strips the DI wiring and every provider fails to resolve at runtime.
 *
 * `npm run build` compiles with tsc, which does emit that metadata. This file
 * only wraps the result, so nothing here needs transforming.
 *
 * The app is created once per warm container and reused, so only a cold start
 * pays the bootstrap cost.
 */

let cached = null;

function getApp() {
  if (!cached) {
    cached = (async () => {
      const { createApp } = require("../dist/main.js");
      const app = await createApp();
      await app.init();
      return app.getHttpAdapter().getInstance();
    })().catch((error) => {
      // A rejected promise left in `cached` would poison this container for its
      // whole lifetime: every later request would replay the same failure
      // without ever retrying. Clear it so the next request gets a fresh boot.
      cached = null;
      throw error;
    });
  }
  return cached;
}

/**
 * A boot failure is the one error the exception filter can never see, because
 * there is no app to run it. It is also the worst one to leave unreported: the
 * whole API is down and the only trace is a line in the platform log.
 *
 * Everything here is best-effort and wrapped, because a failure to report a
 * failure must not replace the real error with a less useful one. `dist/main.js`
 * imports `dist/instrument.js` at its top, so the SDK is already started by the
 * time `createApp()` throws; if the require itself was what failed, this is a
 * no-op and the caller still gets the BOOTSTRAP_FAILED envelope below.
 */
async function reportBootstrapFailure(req, error) {
  try {
    const sentry = require("../dist/observability/sentry.js");
    if (!sentry.initSentry()) return;
    sentry.reportException(error, {
      requestId: req.headers["x-request-id"] || "bootstrap",
      code: "BOOTSTRAP_FAILED",
      status: 500,
      method: req.method,
      url: req.url,
    });
    await sentry.flushErrorReports();
  } catch {
    // Nothing further to try — console.error above is the remaining record.
  }
}

/** Resolves once the response has been written, however it ended. */
function responseSettled(res) {
  if (res.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    res.once("finish", resolve);
    res.once("close", resolve);
  });
}

/** Best-effort delivery of anything the request queued. Never throws. */
async function flushReports() {
  try {
    await require("../dist/observability/sentry.js").flushErrorReports();
  } catch {
    // The SDK is not loaded, which means nothing was queued either.
  }
}

/**
 * Boot failures must still answer with CORS headers, or the browser reports an
 * opaque network error and the real reason — a missing env var, an unreachable
 * database — never reaches whoever is debugging it.
 */
function allowOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("vary", "Origin");
}

module.exports = async function handler(req, res) {
  let instance;
  try {
    instance = await getApp();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Bootstrap failed", error);
    await reportBootstrapFailure(req, error);
    allowOrigin(req, res);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: "BOOTSTRAP_FAILED",
          message:
            "The API could not start. This is a deployment problem, not a bad request — " +
            "check the environment variables and the database connection.",
          details: [{ field: "bootstrap", issue: String((error && error.message) || error) }],
        },
        meta: { requestId: req.headers["x-request-id"] || "bootstrap" },
      }),
    );
    return;
  }

  instance(req, res);

  /**
   * The handler resolves only once the response is written, so the flush below
   * happens while the container is still alive. Without it the SDK's background
   * batching would be racing a freeze it always loses.
   */
  await responseSettled(res);
  await flushReports();
};
