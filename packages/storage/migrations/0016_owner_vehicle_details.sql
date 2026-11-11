ALTER TABLE owner_vehicles ADD COLUMN body_type text;
ALTER TABLE owner_vehicles ADD COLUMN transmission text;
ALTER TABLE owner_vehicles ADD COLUMN photos jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE owner_vehicles ADD CONSTRAINT owner_photos_array CHECK (jsonb_typeof(photos) = 'array' AND jsonb_array_length(photos) <= 3);
