-- A demonstrable consent record.
--
-- `LocationConsent` holds one row per user and is upserted on every change, so
-- it answers "may we ask for a fix right now" and nothing else. A withdrawal
-- overwrites the grant it replaced, which leaves the authority unable to show
-- that consent was ever given, when, or against what wording.
--
-- Section 6 of the DPDP Act puts that burden of proof on the fiduciary, so the
-- history gets its own table. Nothing in the application updates or deletes a
-- row of it; it is written once, at the moment of the decision.
--
-- Purely additive. `LocationConsent` is untouched and keeps working exactly as
-- it did — the ledger is written alongside it.

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('PRECISE_LOCATION', 'EVIDENCE_PHOTOGRAPHY', 'SERVICE_MESSAGES', 'ANNOUNCEMENTS');

-- CreateEnum
CREATE TYPE "ConsentAction" AS ENUM ('GRANTED', 'WITHDRAWN', 'DENIED');

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "action" "ConsentAction" NOT NULL,
    "noticeSlug" TEXT,
    "noticeVersion" TIMESTAMP(3),
    "channel" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_purpose_createdAt_idx" ON "ConsentRecord"("userId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_purpose_action_createdAt_idx" ON "ConsentRecord"("purpose", "action", "createdAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_createdAt_idx" ON "ConsentRecord"("createdAt");
