-- Fixed-asset register. An asset is bought once and written down month by month. Depreciation is booked as ONE journal per month for all
-- assets (Dr Depreciation Expense, Cr Accumulated Depreciation); fixed_asset_depreciation keeps each asset's share of that journal so the
-- register can show a schedule without re-deriving it. Disposal books one journal that removes cost and accumulated depreciation and
-- records the gain or loss against proceeds.
--
-- Months are whole months: an asset starts depreciating in the month it is put in service and the last month never takes it below its
-- residual value. Depreciation is only ever added for the next unbooked month, so a run can be repeated safely.
CREATE TABLE fixed_assets (
    id                       uuid PRIMARY KEY,
    organisation_id          uuid NOT NULL REFERENCES organisations(id),
    code                     text NOT NULL DEFAULT '',
    name                     text NOT NULL CHECK (length(btrim(name)) > 0),
    category                 text NOT NULL DEFAULT '',
    purchase_date            date NOT NULL,
    in_service_date          date NOT NULL,
    cost                     numeric(20,2) NOT NULL CHECK (cost > 0),
    residual_value           numeric(20,2) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
    life_months              integer NOT NULL CHECK (life_months BETWEEN 1 AND 1200),
    method                   text NOT NULL CHECK (method IN ('STRAIGHT_LINE', 'DECLINING_BALANCE')),
    -- Annual rate for DECLINING_BALANCE (percent of the book value at the start of each month / 12). NULL for straight line.
    rate_percent             numeric(7,4) CHECK (rate_percent IS NULL OR (rate_percent > 0 AND rate_percent <= 100)),
    accumulated_depreciation numeric(20,2) NOT NULL DEFAULT 0 CHECK (accumulated_depreciation >= 0),
    depreciated_through      date,
    status                   text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISPOSED')),
    acquisition_journal_id   uuid REFERENCES journals(id),
    disposal_journal_id      uuid REFERENCES journals(id),
    disposed_on              date,
    disposal_proceeds        numeric(20,2),
    note                     text NOT NULL DEFAULT '',
    created_by               uuid NOT NULL REFERENCES users(id),
    created_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fixed_assets_residual_below_cost CHECK (residual_value < cost),
    CONSTRAINT fixed_assets_method_rate CHECK ((method = 'DECLINING_BALANCE') = (rate_percent IS NOT NULL)),
    CONSTRAINT fixed_assets_accumulated_cap CHECK (accumulated_depreciation <= cost - residual_value),
    CONSTRAINT fixed_assets_disposed CHECK ((status = 'DISPOSED') = (disposed_on IS NOT NULL))
);
CREATE INDEX idx_fixed_assets_org ON fixed_assets (organisation_id, status, in_service_date);
CREATE UNIQUE INDEX uq_fixed_assets_code ON fixed_assets (organisation_id, lower(code)) WHERE code <> '';

CREATE TABLE fixed_asset_depreciation (
    id              uuid PRIMARY KEY,
    organisation_id uuid NOT NULL REFERENCES organisations(id),
    asset_id        uuid NOT NULL REFERENCES fixed_assets(id),
    period_end      date NOT NULL,
    amount          numeric(20,2) NOT NULL CHECK (amount > 0),
    journal_id      uuid NOT NULL REFERENCES journals(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (asset_id, period_end)
);
CREATE INDEX idx_fixed_asset_depreciation_org ON fixed_asset_depreciation (organisation_id, period_end);

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixed_assets_tenant_isolation ON fixed_assets
    USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid)
    WITH CHECK (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
ALTER TABLE fixed_asset_depreciation ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixed_asset_depreciation_tenant_isolation ON fixed_asset_depreciation
    USING (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid)
    WITH CHECK (organisation_id = NULLIF(current_setting('app.current_organisation_id', true), '')::uuid);
