import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Env } from "@/config/env.config";

/**
 * Prisma 7: the adapter carries the connection string. There is no
 * `datasourceUrl` argument on the client and no `url` in the schema datasource.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<Env, true>) {
    const connectionString = config.get("DATABASE_URL", { infer: true });
    super({
      adapter: new PrismaPg({ connectionString }),
      log:
        config.get("NODE_ENV", { infer: true }) === "development"
          ? ["warn", "error"]
          : ["error"],
    });
  }

  /**
   * Deliberately does not `$connect()`.
   *
   * Prisma opens a connection on first query anyway. Connecting eagerly here
   * runs inside Nest's init hooks, so on a serverless cold start a database
   * that is briefly unreachable takes down the whole function — every route,
   * including the health probe that exists to tell you what is wrong. Lazy
   * connection keeps a database outage a database error.
   */
  onModuleInit(): void {
    this.logger.log("Prisma ready (connecting lazily)");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Used by the readiness probe. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
