-- CCTV cameras, filed against the road they are bolted to.
--
-- A Street rather than a Zone: the hardware is on a stretch of kerb, and the
-- zones priced along that kerb are redrawn without anybody climbing a pole.
--
-- Two things are deliberately absent. There is no RTSP URL and no credential
-- column — a camera password in a table is a camera password in every backup
-- and every replica, and it is the one secret that turns a parking system into
-- somebody's window onto a street. `streamKey` names a stream on the gateway;
-- the gateway holds the connection details.
--
-- And there are no recording columns. This is live viewing only. Footage
-- retained is footage that falls under the DPDP Act's retention and
-- subject-access duties, and none of that is warranted for a picture nobody
-- keeps. Adding recording later is an additive migration and a policy decision,
-- in that order.

-- CreateEnum
CREATE TYPE "CameraStatus" AS ENUM ('ONLINE', 'OFFLINE', 'DEGRADED', 'MAINTENANCE', 'DECOMMISSIONED');

-- CreateTable
CREATE TABLE "Camera" (
    "id" TEXT NOT NULL,
    "streetId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "makeModel" TEXT,
    "streamKey" TEXT,
    "status" "CameraStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastSeenAt" TIMESTAMP(3),
    "installedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Camera_code_key" ON "Camera"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Camera_streamKey_key" ON "Camera"("streamKey");

-- CreateIndex
CREATE INDEX "Camera_streetId_status_idx" ON "Camera"("streetId", "status");

-- CreateIndex
CREATE INDEX "Camera_status_idx" ON "Camera"("status");

-- AddForeignKey
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_streetId_fkey" FOREIGN KEY ("streetId") REFERENCES "Street"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Viewing a street's cameras and managing them are separate grants, held by the
-- authority only for now. Zone officers and vendors are not given sight of a
-- live street until somebody has decided they should be.
UPDATE "Role"
SET "permissions" = ARRAY(
      SELECT DISTINCT unnest("permissions" || ARRAY['camera.view','camera.manage']::TEXT[])
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'ADMIN';
