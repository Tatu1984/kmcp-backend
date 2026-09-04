-- Generated documents: receipts, settlement statements, shift slips and zone signage.
--
-- Two additive changes, no data movement.
--
-- The enum gains three values because MediaAccessService keys the read rule on
-- MediaPurpose. Filing all four documents under REPORT_EXPORT would have given
-- a tariff board the audience of a revenue export, and would have kept a
-- vendor's own settlement statement behind report.generate — a grant a vendor
-- has never held.
--
-- The two nullable columns are the back-reference the access check needs.
-- A Media row does not know what it is; ownership is read from the record that
-- points at it, exactly as Receipt.pdfMediaId and Settlement.statementMediaId
-- already do for the other two documents.

-- AlterEnum
ALTER TYPE "MediaPurpose" ADD VALUE 'SETTLEMENT_STATEMENT';
ALTER TYPE "MediaPurpose" ADD VALUE 'SHIFT_SLIP';
ALTER TYPE "MediaPurpose" ADD VALUE 'ZONE_SIGNAGE';

-- AlterTable
ALTER TABLE "Zone" ADD COLUMN "signageMediaId" TEXT;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN "slipMediaId" TEXT;
