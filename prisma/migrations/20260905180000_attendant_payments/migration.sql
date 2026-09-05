-- Vendor-to-attendant payments.
--
-- KMC contracts the vendor and settles with the vendor. The vendor employs the
-- attendant and pays them, and until now that second leg existed only on paper:
-- the sole record that an attendant had been paid belonged to the person who
-- owed them the money.
--
-- Additive throughout. One enum, one table, two indexes, two foreign keys, and
-- two permissions appended to the vendor role.
--
-- Note what this migration does NOT do: it adds no LedgerEntry account. The
-- shared ledger is read by the authority under `settlement.read`, and posting
-- wages there would publish what every vendor pays every attendant in the city
-- to anyone holding that grant. The table below is scoped to its vendor in the
-- service layer and is read nowhere else.

-- CreateEnum
CREATE TYPE "AttendantPayMode" AS ENUM ('CASH', 'UPI', 'BANK_TRANSFER');

-- CreateTable
CREATE TABLE "AttendantPayment" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "attendantId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "mode" "AttendantPayMode" NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "reference" TEXT,
    "note" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendantPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendantPayment_vendorId_paidAt_idx" ON "AttendantPayment"("vendorId", "paidAt");

-- CreateIndex
CREATE INDEX "AttendantPayment_attendantId_paidAt_idx" ON "AttendantPayment"("attendantId", "paidAt");

-- AddForeignKey
ALTER TABLE "AttendantPayment" ADD CONSTRAINT "AttendantPayment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendantPayment" ADD CONSTRAINT "AttendantPayment_attendantId_fkey" FOREIGN KEY ("attendantId") REFERENCES "Attendant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Grant the two new permissions to the vendor role, and to no other role.
-- Appended rather than replaced so an authority that has since edited the
-- vendor's grants does not lose the edit.
UPDATE "Role"
SET "permissions" = ARRAY(
      SELECT DISTINCT unnest("permissions" || ARRAY['attendant.pay.read','attendant.pay.write']::TEXT[])
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'VENDOR';
