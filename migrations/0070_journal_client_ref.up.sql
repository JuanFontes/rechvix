-- A manual journal (an expense entered on a phone, say) becomes safe to retry: client_ref is an opaque id chosen by the caller, and a second
-- POST with the same value returns the journal that already exists instead of posting the money twice.
ALTER TABLE journals ADD COLUMN client_ref text CHECK (client_ref IS NULL OR length(client_ref) BETWEEN 1 AND 100);
CREATE UNIQUE INDEX uq_journals_client_ref ON journals (organisation_id, client_ref) WHERE client_ref IS NOT NULL;
