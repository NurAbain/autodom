-- One filter for every marketplace: the vehicle text moves into the query, and the
-- source-specific criteria are dropped. The catalogue_filter column keeps its shape so
-- an older bot can still read the profiles after a rollback.
UPDATE profiles AS p
SET query = COALESCE(
  (
    SELECT string_agg(picked.value, ', ' ORDER BY picked.ord)
    FROM (
      SELECT COALESCE(v.vehicle->'model'->>'value', v.vehicle->'make'->>'value') AS value,
             v.ord
      FROM jsonb_array_elements(COALESCE(p.catalog_filter->'vehicles', '[]'::jsonb))
        WITH ORDINALITY AS v(vehicle, ord)
    ) AS picked
    WHERE picked.value IS NOT NULL AND picked.value <> ''
  ),
  p.query
)
WHERE p.query = ''
  AND COALESCE(jsonb_array_length(COALESCE(p.catalog_filter->'vehicles', '[]'::jsonb)), 0) > 0;

UPDATE profiles
SET catalog_filter = '{"vehicles":[],"options":{},"ranges":{},"below_market_percent":null}'::jsonb
WHERE catalog_filter <> '{"vehicles":[],"options":{},"ranges":{},"below_market_percent":null}'::jsonb;

ALTER TABLE profiles ADD COLUMN year_max integer;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_year_range CHECK (
    (year_min IS NULL OR year_min >= 1900)
    AND (year_max IS NULL OR year_max >= 1900)
    AND (year_min IS NULL OR year_max IS NULL OR year_max >= year_min)
  );
