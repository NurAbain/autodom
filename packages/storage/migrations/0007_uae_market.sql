ALTER TABLE profiles
  DROP CONSTRAINT profiles_market,
  ADD CONSTRAINT profiles_market CHECK (market IN ('KG','KR','US','AE','ALL'));
