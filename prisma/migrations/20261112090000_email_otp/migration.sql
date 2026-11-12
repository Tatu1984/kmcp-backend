-- One-time codes by email.
--
-- Codes used to be keyed by a mobile number and were never sent: there was no
-- SMS gateway. They now go by email, for three purposes — a citizen signing
-- in, an attendant's second step after the password, and a password reset —
-- and a code is only accepted for the purpose it was issued for. Existing rows
-- keep their phone and default to CITIZEN_SIGN_IN, which is what they were.

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('CITIZEN_SIGN_IN', 'STAFF_SIGN_IN', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "OtpRequest" ADD COLUMN     "email" TEXT,
ADD COLUMN     "purpose" "OtpPurpose" NOT NULL DEFAULT 'CITIZEN_SIGN_IN',
ADD COLUMN     "userId" TEXT,
ALTER COLUMN "phone" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "OtpRequest_email_purpose_createdAt_idx" ON "OtpRequest"("email", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "OtpRequest_userId_purpose_createdAt_idx" ON "OtpRequest"("userId", "purpose", "createdAt");

