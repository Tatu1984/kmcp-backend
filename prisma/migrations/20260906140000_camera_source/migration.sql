-- What a camera is connected to, and what it last told us about itself.
--
-- Until now a camera was a label on a road and a status somebody else set.
-- Registering one through the portal was impossible — there was no screen, and
-- nothing to put in it beyond a code and a caption. This gives the row the
-- source the gateway pulls from, the credentials it needs to do so, the facts
-- about the device an engineer wants before they drive out to it, and what the
-- last probe found.
--
-- Additive throughout: every column is nullable or carries a default, so rows
-- registered before this migration keep working and simply have no source.
--
-- On the two credential columns. They hold AES-256-GCM ciphertext, not
-- passwords, and they are the only columns in this schema that do. They are
-- decrypted in exactly one place — building the source URL handed to the
-- streaming gateway — and they are absent from every response shape the API
-- can produce. `rtspUrl` is stored as given, which may include userinfo if
-- whoever registered it pasted a credentialed URL; the service strips that
-- before the address is ever sent to a browser.

-- AlterTable
ALTER TABLE "Camera"
  ADD COLUMN "rtspUrl"       TEXT,
  ADD COLUMN "onvifUrl"      TEXT,
  ADD COLUMN "usernameEnc"   TEXT,
  ADD COLUMN "passwordEnc"   TEXT,
  ADD COLUMN "coverageSlots" INTEGER,
  ADD COLUMN "hasIR"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hasPTZ"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isActive"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "resolution"    TEXT,
  ADD COLUMN "fps"           INTEGER,
  ADD COLUMN "probedAt"      TIMESTAMP(3),
  ADD COLUMN "probeError"    TEXT;

-- A camera taken out of service is the common filter on the list screen, and
-- it is asked alongside the status the header counts.
CREATE INDEX "Camera_isActive_status_idx" ON "Camera"("isActive", "status");
