ALTER TABLE profiles
  ADD COLUMN catalog_filter jsonb NOT NULL DEFAULT '{"vehicles":[],"options":{},"ranges":{},"below_market_percent":null}'::jsonb,
  ADD CONSTRAINT profiles_catalog_filter CHECK (jsonb_typeof(catalog_filter) = 'object');

ALTER TABLE listings ADD COLUMN normalized_title text NOT NULL DEFAULT '';
