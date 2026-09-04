-- Scheduled reports.
--
-- Purely additive: one enum, one table, two indexes. Nothing existing is
-- touched, and with no rows in the new table the runner finds nothing due and
-- the platform behaves exactly as it did before this migration.
--
-- Two column choices are worth stating, because both are the kind of thing a
-- later reader would otherwise "simplify".
--
-- The recurrence is stored in pieces — frequency, hour, minute, weekday,
-- dayOfMonth, timezone — rather than as a cron expression. Three cadences are
-- what a municipal authority actually asks for, and a cron string would buy the
-- rest at the cost of a parser, an unvalidatable text box, and a row nobody can
-- read the next run off.
--
-- And "timezone" sits beside them rather than being assumed. Every timestamp in
-- this database is UTC; every screen renders Asia/Kolkata. A schedule that
-- recorded only the UTC instant would have lost the authority's intent, and
-- "the Monday morning collection summary" would arrive on Sunday afternoon.
-- nextRunAt is the instant that intent resolves to, recomputed on every write
-- and after every run — it is a cache of the intent, never the intent itself.

-- CreateEnum
CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "frequency" "ReportFrequency" NOT NULL,
    "hour" INTEGER NOT NULL DEFAULT 6,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "weekday" INTEGER,
    "dayOfMonth" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "channels" TEXT[],
    "ownerId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "lastJobId" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The runner's only query: active schedules that are due, oldest first. Without
-- it a sweep every quarter hour is a sequential scan of every schedule the
-- authority has ever created.
CREATE INDEX "ReportSchedule_isActive_nextRunAt_idx" ON "ReportSchedule"("isActive", "nextRunAt");

-- CreateIndex
CREATE INDEX "ReportSchedule_ownerId_createdAt_idx" ON "ReportSchedule"("ownerId", "createdAt");
