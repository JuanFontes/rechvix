-- Labels and custom fields. Both attach to a contact (PARTY), product, sales document or purchase document by (entity_type, entity_id).
-- entity_id is not a foreign key because it points into four different tables; the service checks the row exists in the organisation before it
-- writes, and rows for a deleted entity are harmless (they are never listed without the entity).
--
-- A label is a coloured name ("Wholesale", "Overdue-watch") that can be put on many entities. A custom field is a typed question the
-- organisation adds ("Birthday", "Account manager"); each entity holds at most one answer per field, stored as text and checked against the
-- field's type on write.
CREATE TABLE labels (
    id              uuid PRIMARY KEY,
    organisation_id uuid NOT NULL REFERENCES organisations(id),
    name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
    colour          text NOT NULL DEFAULT 'grey' CHECK (colour IN ('grey', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink')),
    created_by      uuid NOT NULL REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_labels_name ON labels (organisation_id, lower(name));

CREATE TABLE label_assignments (
    organisation_id uuid NOT NULL REFERENCES organisations(id),
    label_id        uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    entity_type     text NOT NULL CHECK (entity_type IN ('PARTY', 'PRODUCT', 'SALES_DOCUMENT', 'PURCHASE_DOCUMENT')),
    entity_id       uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (label_id, entity_type, entity_id)
);
CREATE INDEX idx_label_assignments_entity ON label_assignments (organisation_id, entity_type, entity_id);

CREATE TABLE custom_field_definitions (
    id              uuid PRIMARY KEY,
    organisation_id uuid NOT NULL REFERENCES organisations(id),
    entity_type     text NOT NULL CHECK (entity_type IN ('PARTY', 'PRODUCT', 'SALES_DOCUMENT', 'PURCHASE_DOCUMENT')),
    name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    field_type      text NOT NULL CHECK (field_type IN ('TEXT', 'NUMBER', 'DATE', 'YES_NO', 'CHOICE')),
    options         text[] NOT NULL DEFAULT '{}',
    position        integer NOT NULL DEFAULT 0,
    created_by      uuid NOT NULL REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT custom_field_choice_options CHECK ((field_type = 'CHOICE') = (cardinality(options) > 0))
);
CREATE UNIQUE INDEX uq_custom_field_name ON custom_field_definitions (organisation_id, entity_type, lower(name));

CREATE TABLE custom_field_values (
    organisation_id uuid NOT NULL REFERENCES organisations(id),
    field_id        uuid NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
    entity_type     text NOT NULL,
    entity_id       uuid NOT NULL,
    value           text NOT NULL CHECK (length(value) BETWEEN 1 AND 500),
    updated_by      uuid NOT NULL REFERENCES users(id),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (field_id, entity_id)
);
CREATE INDEX idx_custom_field_values_entity ON custom_field_values (organisation_id, entity_type, entity_id);

ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY labels_tenant_isolation ON labels
    USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid)
    WITH CHECK (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
ALTER TABLE label_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY label_assignments_tenant_isolation ON label_assignments
    USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid)
    WITH CHECK (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY custom_field_definitions_tenant_isolation ON custom_field_definitions
    USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid)
    WITH CHECK (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
ALTER TABLE custom_field_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY custom_field_values_tenant_isolation ON custom_field_values
    USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid)
    WITH CHECK (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
