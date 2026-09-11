-- Replace the MediaMTX-gateway camera model with the push→R2 model.
--
-- The old feature (a Camera filed against a Street, streamed through a MediaMTX
-- gateway, with AES-GCM credential columns) is gone. Cameras now receive their
-- HLS from an on-site Edge Agent over HTTP PUT and are played back through this
-- API, gated to administrators. A camera is a name plus the ingest key and
-- token hash that route and authenticate one camera's upload — no street link,
-- no RTSP URL, no stored credentials, no heartbeat status column.
--
-- This migration is destructive to the OLD Camera table on purpose: it carried
-- gateway plumbing that has no counterpart here. Any rows in it were test
-- fixtures for a feature that never went live.

-- Drop the old camera table and its enum. CASCADE clears its indexes and the
-- Street foreign key with it.
DROP TABLE IF EXISTS "Camera" CASCADE;
DROP TYPE IF EXISTS "CameraStatus";

-- Take back the camera grants the old cameras migration added to ADMIN. The
-- permission keys no longer exist in the catalogue, so leaving them on the row
-- would be dead entries that the RBAC conformance test rejects.
UPDATE "Role"
SET "permissions" = ARRAY(
      SELECT p FROM unnest("permissions") AS p
      WHERE p NOT IN ('camera.view', 'camera.manage')
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE 'camera.view' = ANY("permissions") OR 'camera.manage' = ANY("permissions");

-- The new push→R2 camera.
CREATE TABLE "Camera" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grp" TEXT,
    "ingestKey" TEXT NOT NULL,
    "ingestTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Camera_ingestKey_key" ON "Camera"("ingestKey");

-- CreateIndex
CREATE INDEX "Camera_ingestKey_idx" ON "Camera"("ingestKey");
