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

  return instance(req, res);
};
