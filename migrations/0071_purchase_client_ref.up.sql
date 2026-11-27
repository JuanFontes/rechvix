-- Supplier bills and supplier payments become safe to retry from a phone on a flaky connection. client_ref is an opaque id chosen by the caller:
-- a second request with the same value returns the document or payment that already exists instead of creating or booking it again.
ALTER TABLE purchase_documents ADD COLUMN client_ref text CHECK (client_ref IS NULL OR length(client_ref) BETWEEN 1 AND 100);
CREATE UNIQUE INDEX uq_purchase_documents_client_ref ON purchase_documents (organisation_id, client_ref) WHERE client_ref IS NOT NULL;
ALTER TABLE payments ADD COLUMN client_ref text CHECK (client_ref IS NULL OR length(client_ref) BETWEEN 1 AND 100);
CREATE UNIQUE INDEX uq_payments_client_ref ON payments (organisation_id, client_ref) WHERE client_ref IS NOT NULL;
