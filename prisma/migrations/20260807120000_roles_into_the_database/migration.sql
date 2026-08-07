-- Roles and permissions move from code into the database.
--
-- Ordering matters and Prisma cannot infer it: the Role rows have to exist
-- before User.role can reference them, and User.role has to stop being an enum
-- before a custom role can ever be assigned. Each step below is a prerequisite
-- of the next, which is why this migration is written by hand.

-- 1. The table.
CREATE TABLE "Role" (
    "code"         TEXT NOT NULL,
    "label"        TEXT NOT NULL,
    "description"  TEXT,
    "permissions"  TEXT[],
    "isSystem"     BOOLEAN NOT NULL DEFAULT false,
    "isZoneScoped" BOOLEAN NOT NULL DEFAULT false,
    "isSuperuser"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Role_pkey" PRIMARY KEY ("code")
);

CREATE INDEX "Role_isSystem_idx" ON "Role"("isSystem");

-- 2. Seed the seven system roles with exactly the grants the guards enforce
--    today, so nobody's access changes at the moment of migration.
INSERT INTO "Role" ("code", "label", "description", "permissions", "isSystem", "isZoneScoped", "isSuperuser", "updatedAt")
VALUES
  ('SUPER_ADMIN', 'Super Admin', 'Unrestricted. Can change roles and system configuration.', ARRAY[]::TEXT[], true, false, true, CURRENT_TIMESTAMP),
  ('ADMIN', 'Administrator', 'Runs day-to-day operations, money and partners. Cannot change system configuration.', ARRAY['zone.read','zone.write','zone.status','slot.write','session.read','session.cancel','incident.manage','vendor.read','vendor.write','vendor.approve','attendant.write','shift.verify','tariff.read','tariff.write','tariff.publish','discount.write','pass.write','payment.read','payment.refund','settlement.read','settlement.approve','settlement.payout','report.generate','audit.read','user.manage','cms.write']::TEXT[], true, false, false, CURRENT_TIMESTAMP),
  ('ZONE_OFFICER', 'Zone Officer', 'Sees and operates only the zones assigned to them.', ARRAY['zone.read','zone.status','session.read','incident.manage','vendor.read','tariff.read','report.generate']::TEXT[], true, true, false, CURRENT_TIMESTAMP),
  ('AUDITOR', 'Auditor', 'Read-only across the platform, including the audit trail.', ARRAY['zone.read','session.read','vendor.read','tariff.read','payment.read','settlement.read','report.generate','audit.read']::TEXT[], true, false, false, CURRENT_TIMESTAMP),
  ('VENDOR', 'Vendor', 'Their own organisation: zones held, staff, collections and settlements.', ARRAY['zone.read','session.read','attendant.write','payment.read','settlement.read']::TEXT[], true, true, false, CURRENT_TIMESTAMP),
  ('ATTENDANT', 'Attendant', 'The kerb. Starts and ends parking sessions on a bound device.', ARRAY['zone.read','session.read']::TEXT[], true, true, false, CURRENT_TIMESTAMP),
  ('CITIZEN', 'Citizen', 'The public app. No portal access at all.', ARRAY[]::TEXT[], true, false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- 3. The column becomes text. Enum labels and role codes are identical, so
--    every existing user keeps the role they already had.
ALTER TABLE "User" ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT;

-- 4. Only now can the foreign key be trusted to hold.
ALTER TABLE "User"
  ADD CONSTRAINT "User_role_fkey" FOREIGN KEY ("role")
  REFERENCES "Role"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. The enum is no longer referenced by anything.
DROP TYPE "UserRole";
