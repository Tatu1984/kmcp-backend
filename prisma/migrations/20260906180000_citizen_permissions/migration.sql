-- Citizen self-service permissions.
--
-- CITIZEN was seeded with zero permissions and has never been granted any
-- since: the role exists so a logged-in citizen has a row to hang a token
-- off, not because a citizen was ever meant to reach a staff endpoint. Two
-- routes now need to open to citizens without opening to every VENDOR or
-- ATTENDANT permission holder, so this grants exactly two scoped permissions
-- built for that purpose: viewing zones the public may see, and viewing and
-- paying for one's own sessions.
--
-- Additive throughout. No table, no column — just two permissions appended
-- to the citizen role.
--
-- Appended rather than replaced so an authority that has since edited the
-- citizen role's grants in the portal does not lose the edit.
UPDATE "Role"
SET "permissions" = ARRAY(
      SELECT DISTINCT unnest("permissions" || ARRAY['zone.read.public','session.read.own']::TEXT[])
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'CITIZEN';
