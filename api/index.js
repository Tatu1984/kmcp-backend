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
const { createApp } = require("../dist/main.js");

let cached = null;

function getApp() {
  if (!cached) {
    cached = createApp().then(async (app) => {
      await app.init();
      return app.getHttpAdapter().getInstance();
    });
  }
  return cached;
}

module.exports = async function handler(req, res) {
  const instance = await getApp();
  return instance(req, res);
};
