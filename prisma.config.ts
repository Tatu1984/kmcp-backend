import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 keeps the datasource URL here, not in schema.prisma.
 *
 * Note: when a Prisma config file is present, Prisma does not auto-load .env
 * files. Load them yourself before running CLI commands:
 *   set -a && . ./.env && set +a && npm run db:migrate
 */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
