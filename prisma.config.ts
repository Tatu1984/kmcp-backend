import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 keeps the datasource URL here, not in schema.prisma.
 *
 * Note: when a Prisma config file is present, Prisma does not auto-load .env
 * files. Load them yourself before running CLI commands:
 *   set -a && . ./.env && set +a && npm run db:migrate
 *
 * Migrations are applied deliberately with `npm run db:deploy`, never from the
 * Vercel build. `migrate deploy` takes a Postgres advisory lock, and a build
 * runner cannot reliably hold one: against the pooled host the lock is held on
 * a backend the pooler may hand to someone else, and two concurrent builds
 * contend for it either way. Both failure modes surface as P1002 and fail a
 * deployment over a migration set that was already applied.
 */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    /**
     * CLI commands use the direct connection, not the pooled one.
     *
     * `migrate deploy` takes a Postgres advisory lock before it applies
     * anything, and an advisory lock cannot survive a transaction pooler — the
     * lock is held on a backend the pooler is free to hand to someone else.
     * Against Neon's `-pooler` host the migration simply waits ten seconds and
     * fails with P1002, which failed the deployment.
     *
     * `DIRECT_URL` is in the environment for exactly this. It is read only
     * here, by the CLI; the running application keeps using the pooled
     * `DATABASE_URL` through `PrismaService`, which is what a serverless
     * function wants.
     */
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
});
