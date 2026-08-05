import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import compression from "compression";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AppModule } from "./app.module";
import { corsOrigins, type Env } from "./config/env.config";
import { APP, HEADERS } from "./config/app.constants";

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(ConfigService<Env, true>);
  const prefix = config.get("API_PREFIX", { infer: true });

  app.setGlobalPrefix(prefix);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(compression());
  app.set("trust proxy", 1);

  app.enableCors({
    origin: corsOrigins(config.get("CORS_ORIGINS", { infer: true })),
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      HEADERS.deviceId,
      HEADERS.clientVersion,
      HEADERS.idempotencyKey,
      HEADERS.requestId,
    ],
    exposedHeaders: [HEADERS.requestId],
  });

  // Webhook signature verification needs the exact bytes the provider signed.
  app.useBodyParser("json", {
    limit: "2mb",
    verify: (req: { rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
      req.rawBody = buf;
    },
  });

  if (config.get("SWAGGER_ENABLED", { infer: true })) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle(`${APP.name} API`)
        .setDescription(
          `${APP.fullName}. Phase ${APP.phase} — the attendant photographs the number plate and ` +
            "types the registration number; ANPR arrives in Phase 2.\n\n" +
            "Every response uses the envelope `{ success, data, meta }`. Errors carry a stable " +
            "`error.code` — branch on that, never on `error.message`.",
        )
        .setVersion(APP.version)
        .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" }, "bearer")
        .addGlobalParameters({
          name: HEADERS.deviceId,
          in: "header",
          required: false,
          description: "Device fingerprint. Mandatory for attendant accounts.",
          schema: { type: "string" },
        })
        .build(),
    );
    SwaggerModule.setup(`${prefix}/docs`, app, document, {
      jsonDocumentUrl: `${prefix}/docs.json`,
      swaggerOptions: { persistAuthorization: true },
    });
  }

  app.enableShutdownHooks();
  return app;
}

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get(ConfigService<Env, true>);
  const port = config.get("PORT", { infer: true });
  const prefix = config.get("API_PREFIX", { infer: true });

  await app.listen(port);
  const logger = new Logger("Bootstrap");
  logger.log(`${APP.name} API listening on http://localhost:${port}/${prefix}`);
  if (config.get("SWAGGER_ENABLED", { infer: true })) {
    logger.log(`OpenAPI docs at http://localhost:${port}/${prefix}/docs`);
  }
}

// Skipped when the module is imported by the serverless entry point.
if (require.main === module) {
  void bootstrap();
}
