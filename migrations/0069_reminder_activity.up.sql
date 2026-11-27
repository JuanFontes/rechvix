-- Reminders a person prepared or handed off by hand (phone app or web): who was reminded, about which invoice, through which channel,
-- and how far it got. "share_opened" means the share sheet or chat was opened; Rechvix cannot see delivery, so no delivered status exists.
-- client_ref makes a retried upload book once.
CREATE TABLE reminder_activity (
    id                 uuid PRIMARY KEY,
    organisation_id    uuid NOT NULL REFERENCES organisations(id),
    party_id           uuid NOT NULL REFERENCES parties(id),
    sales_document_id  uuid REFERENCES sales_documents(id),
    channel            text NOT NULL CHECK (channel IN ('whatsapp', 'share', 'text', 'email', 'sms', 'other')),
    status             text NOT NULL CHECK (status IN ('prepared', 'share_opened', 'marked_sent', 'cancelled')),
    with_pdf           boolean NOT NULL DEFAULT false,
    outstanding        numeric(20,6),
    client_ref         text NOT NULL CHECK (length(client_ref) BETWEEN 1 AND 100),
    occurred_at        timestamptz NOT NULL,
    created_by         uuid NOT NULL REFERENCES users(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organisation_id, client_ref)
);
CREATE INDEX idx_reminder_activity_party ON reminder_activity(organisation_id, party_id, occurred_at DESC);
CREATE INDEX idx_reminder_activity_document ON reminder_activity(organisation_id, sales_document_id, occurred_at DESC) WHERE sales_document_id IS NOT NULL;
ALTER TABLE reminder_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY reminder_activity_tenant_isolation ON reminder_activity
    USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid)
    WITH CHECK (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
