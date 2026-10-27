-- The text filter of the buyer search runs on every preview and model request.
-- pg_trgm lets the leading-wildcard match use an index instead of a table scan.
-- The index itself is built in the background after the service starts, because
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'pg_trgm is unavailable; the text filter keeps the sequential scan';
END $$;
