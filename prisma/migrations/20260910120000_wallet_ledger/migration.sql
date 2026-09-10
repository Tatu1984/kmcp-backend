-- A citizen's wallet ledger.
--
-- Deliberately not a mutable stored balance. Same philosophy as this
-- codebase's shift/settlement reconciliation: a balance kept as a column
-- can drift from reality the moment a write is missed or double-applied,
-- and nobody could tell without replaying every session. The current
-- balance is always the sum of a user's WalletEntry rows; `balanceAfter`
-- is stored per row purely so displaying history doesn't require
-- re-summing on every read — only the *current* balance is re-derived by
-- summing.
--
-- Additive throughout: one enum, one table, one index, two foreign keys,
-- and one nullable column (with its own foreign key) on the existing
-- Payment table so a captured gateway payment can be marked as crediting a
-- citizen's wallet instead of paying for a session or pass.

-- CreateEnum
CREATE TYPE "WalletEntryKind" AS ENUM ('TOPUP', 'SESSION_DEBIT', 'REFUND', 'REVERSAL', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "WalletEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "WalletEntryKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "sessionId" TEXT,
    "zoneId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletEntry_userId_createdAt_idx" ON "WalletEntry"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "walletTopUpUserId" TEXT;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_walletTopUpUserId_fkey" FOREIGN KEY ("walletTopUpUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
