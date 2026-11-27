DROP INDEX IF EXISTS uq_payments_client_ref;
ALTER TABLE payments DROP COLUMN IF EXISTS client_ref;
DROP INDEX IF EXISTS uq_purchase_documents_client_ref;
ALTER TABLE purchase_documents DROP COLUMN IF EXISTS client_ref;
