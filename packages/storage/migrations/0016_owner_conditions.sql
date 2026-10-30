-- The owner's own car repeats the conditions of the buyer filter: the catalogue
-- make and model, the body, the transmission and the city. Every column is
-- nullable and has no default, so a bot that does not know them yet still
-- reads and writes the card as it was before.
ALTER TABLE owner_vehicles
  ADD COLUMN make_id text,
  ADD COLUMN make_value text,
  ADD COLUMN make_label text,
  ADD COLUMN model_id text,
  ADD COLUMN model_value text,
  ADD COLUMN model_label text,
  ADD COLUMN body_type text,
  ADD COLUMN transmission text,
  ADD COLUMN city text;

-- The catalogue choice is either fully known or fully absent, and every text
-- keeps the length the owner card validator allows.
ALTER TABLE owner_vehicles
  ADD CONSTRAINT owner_make_choice CHECK (
    (make_id IS NULL AND make_value IS NULL AND make_label IS NULL)
    OR (make_id IS NOT NULL AND make_value IS NOT NULL AND make_label IS NOT NULL)
  ),
  ADD CONSTRAINT owner_model_choice CHECK (
    (model_id IS NULL AND model_value IS NULL AND model_label IS NULL)
    OR (model_id IS NOT NULL AND model_value IS NOT NULL AND model_label IS NOT NULL)
  ),
  ADD CONSTRAINT owner_catalogue_text CHECK (
    (make_id IS NULL OR length(trim(make_id)) BETWEEN 1 AND 128)
    AND (make_value IS NULL OR length(trim(make_value)) BETWEEN 1 AND 256)
    AND (make_label IS NULL OR length(trim(make_label)) BETWEEN 1 AND 256)
    AND (model_id IS NULL OR length(trim(model_id)) BETWEEN 1 AND 128)
    AND (model_value IS NULL OR length(trim(model_value)) BETWEEN 1 AND 256)
    AND (model_label IS NULL OR length(trim(model_label)) BETWEEN 1 AND 256)
  ),
  ADD CONSTRAINT owner_body_type CHECK (
    body_type IS NULL OR (
      length(trim(body_type)) BETWEEN 1 AND 32
      AND body_type IN ('sedan','suv','hatchback','wagon','minivan','pickup','coupe','convertible','van')
    )
  ),
  ADD CONSTRAINT owner_transmission CHECK (
    transmission IS NULL OR (
      length(trim(transmission)) BETWEEN 1 AND 32
      AND transmission IN ('manual','automatic','cvt','robot')
    )
  ),
  ADD CONSTRAINT owner_city CHECK (city IS NULL OR length(trim(city)) BETWEEN 1 AND 80);
