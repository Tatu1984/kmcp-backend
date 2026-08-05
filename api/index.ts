import type { IncomingMessage, ServerResponse } from "node:http";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createApp } from "../src/main";

/**
 * Vercel serverless entry point.
 *
 * The Nest app is built once per warm container and reused across invocations,
 * so only a cold start pays the bootstrap cost. Database connections go through
 * Neon's pooler, which is what makes this viable in a serverless runtime.
 */
let cached: Promise<NestExpressApplication> | null = null;

async function getApp(): Promise<NestExpressApplication> {
  if (!cached) {
    cached = createApp().then(async (app) => {
      await app.init();
      return app;
    });
  }
  return cached;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  const instance = app.getHttpAdapter().getInstance();
  return instance(req, res);
}
