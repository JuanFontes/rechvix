-- Bank reconciliation: imported bank-statement lines, each matched to a receipt (money in) or a supplier payment (money out) that is
-- already booked, or ignored with a reason. Matching changes NO journal: the books were posted when the receipt/payment was recorded, and
-- reconciliation only confirms that the bank agrees with them. A bank line that matches nothing is never posted automatically; the user
-- records the missing receipt/payment/expense first, or ignores the line with a note.
--
-- amount is signed from the bank's point of view: positive = money in, negative = money out.
-- line_hash + occurrence make an import idempotent: loading the same statement (or an overlapping one) twice adds nothing, while two
-- genuinely identical lines in one file (same date, amount and text) are kept as occurrence 1 and 2.
CREATE TABLE bank_statement_lines (
    id               uuid PRIMARY KEY,
    organisation_id  uuid NOT NULL REFERENCES organisations(id),
    bank_account_id  uuid NOT NULL REFERENCES bank_accounts(id),
    line_date        date NOT NULL,
    description      text NOT NULL DEFAULT '',
    reference        text NOT NULL DEFAULT '',
    amount           numeric(20,6) NOT NULL CHECK (amount <> 0),
    line_hash        text NOT NULL,
    occurrence       integer NOT NULL DEFAULT 1 CHECK (occurrence >= 1),
    status           text NOT NULL DEFAULT 'UNMATCHED' CHECK (status IN ('UNMATCHED', 'MATCHED', 'IGNORED')),
    matched_kind     text CHECK (matched_kind IN ('RECEIPT', 'PAYMENT')),
    matched_id       uuid,
    note             text NOT NULL DEFAULT '',
    resolved_by      uuid REFERENCES users(id),
    resolved_at      timestamptz,
    imported_by      uuid NOT NULL REFERENCES users(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bank_statement_lines_match_pair CHECK ((matched_kind IS NULL) = (matched_id IS NULL)),
    CONSTRAINT bank_statement_lines_match_status CHECK ((status = 'MATCHED') = (matched_id IS NOT NULL)),
    CONSTRAINT bank_statement_lines_resolved CHECK ((status = 'UNMATCHED') = (resolved_at IS NULL))
);

CREATE UNIQUE INDEX uq_bank_statement_lines_import ON bank_statement_lines (organisation_id, bank_account_id, line_hash, occurrence);
-- One receipt or payment can be the match of only one statement line.
CREATE UNIQUE INDEX uq_bank_statement_lines_target ON bank_statement_lines (organisation_id, matched_kind, matched_id) WHERE status = 'MATCHED';
CREATE INDEX idx_bank_statement_lines_account ON bank_statement_lines (organisation_id, bank_account_id, line_date DESC);
CREATE INDEX idx_bank_statement_lines_status ON bank_statement_lines (organisation_id, bank_account_id, status);

ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_statement_lines_tenant_isolation ON bank_statement_lines
    USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid)
    WITH CHECK (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);

-- Candidate lookups join receipts/payments on their bank account, amount and date.
CREATE INDEX IF NOT EXISTS idx_receipts_bank_amount ON receipts (organisation_id, bank_account_id, amount) WHERE bank_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_bank_amount ON payments (organisation_id, bank_account_id, amount) WHERE bank_account_id IS NOT NULL;
