-- CreateEnum
CREATE TYPE "AuthEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT', 'SESSION_EXPIRED', 'SESSION_REVOKED', 'TOKEN_REUSE_DETECTED');

-- CreateEnum
CREATE TYPE "LocationConsentStatus" AS ENUM ('PENDING', 'GRANTED', 'DENIED');

-- CreateTable
CREATE TABLE "AuthEvent" (
    "id" TEXT NOT NULL,
    "eventType" "AuthEventType" NOT NULL,
    "userId" TEXT,
    "userName" TEXT,
    "userRole" TEXT,
    "sessionId" TEXT,
    "identifierTried" TEXT,
    "failureReason" TEXT,
    "ipAddress" TEXT,
    "city" TEXT,
    "district" TEXT,
    "region" TEXT,
    "postal" TEXT,
    "country" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "geoSource" TEXT,
    "isp" TEXT,
    "asn" TEXT,
    "org" TEXT,
    "isVpnOrProxy" BOOLEAN,
    "ipTimezone" TEXT,
    "userAgent" TEXT,
    "browserName" TEXT,
    "osName" TEXT,
    "deviceType" TEXT,
    "deviceFingerprint" TEXT,
    "clientTimezone" TEXT,
    "gpsLatitude" DOUBLE PRECISION,
    "gpsLongitude" DOUBLE PRECISION,
    "gpsAccuracyM" DOUBLE PRECISION,
    "anomalies" JSONB,
    "riskScore" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT,
    "userRole" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "ipAddress" TEXT,
    "city" TEXT,
    "district" TEXT,
    "region" TEXT,
    "country" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isp" TEXT,
    "asn" TEXT,
    "isVpnOrProxy" BOOLEAN,
    "deviceFingerprint" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "LoginSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedLoginLocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT,
    "ipAddress" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "asn" TEXT,
    "isp" TEXT,
    "label" TEXT,
    "approvedBy" TEXT,
    "approvedByName" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustedLoginLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationConsent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT,
    "userRole" TEXT,
    "status" "LocationConsentStatus" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthEvent_createdAt_idx" ON "AuthEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuthEvent_userId_eventType_idx" ON "AuthEvent"("userId", "eventType");

-- CreateIndex
CREATE INDEX "AuthEvent_ipAddress_idx" ON "AuthEvent"("ipAddress");

-- CreateIndex
CREATE INDEX "AuthEvent_deviceFingerprint_idx" ON "AuthEvent"("deviceFingerprint");

-- CreateIndex
CREATE INDEX "AuthEvent_riskScore_createdAt_idx" ON "AuthEvent"("riskScore", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoginSession_sessionId_key" ON "LoginSession"("sessionId");

-- CreateIndex
CREATE INDEX "LoginSession_userId_revokedAt_expiresAt_idx" ON "LoginSession"("userId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "LoginSession_lastSeenAt_idx" ON "LoginSession"("lastSeenAt");

-- CreateIndex
CREATE INDEX "TrustedLoginLocation_userId_idx" ON "TrustedLoginLocation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedLoginLocation_userId_ipAddress_key" ON "TrustedLoginLocation"("userId", "ipAddress");

-- CreateIndex
CREATE UNIQUE INDEX "LocationConsent_userId_key" ON "LocationConsent"("userId");

-- CreateIndex
CREATE INDEX "LocationConsent_status_idx" ON "LocationConsent"("status");

-- Carry existing sign-in history into the richer AuthEvent table before the old
-- one is dropped. The columns AuthEvent adds (geolocation, device, anomalies)
-- are left null for these rows — they were recorded before we captured them.
INSERT INTO "AuthEvent" (
  "id", "eventType", "userId", "identifierTried", "failureReason",
  "ipAddress", "deviceFingerprint", "createdAt"
)
SELECT
  "id",
  CASE WHEN "success" THEN 'LOGIN_SUCCESS'::"AuthEventType" ELSE 'LOGIN_FAILED'::"AuthEventType" END,
  "userId",
  "identifier",
  "reason",
  "ip",
  "deviceId",
  "createdAt"
FROM "LoginLog";

-- DropTable
DROP TABLE "LoginLog";
