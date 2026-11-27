DROP INDEX IF EXISTS uq_journals_client_ref;
ALTER TABLE journals DROP COLUMN IF EXISTS client_ref;
