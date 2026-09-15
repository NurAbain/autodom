ALTER TABLE payment_orders ADD COLUMN report_kind text;
UPDATE payment_orders SET report_kind = 'korea' WHERE product = 'vin_report';
-- Flush deferred backfill events before changing constraints and indexes.
SET CONSTRAINTS payment_orders_ledger IMMEDIATE;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_report_kind CHECK (
  (product = 'inspection' AND report_kind IS NULL)
  OR (product = 'vin_report' AND (coalesce(report_kind, 'korea') = 'korea'
    OR (report_kind = 'carfax' AND provider = 'finik' AND channel = 'telegram')))
);
DROP INDEX payment_orders_report_lookup;
CREATE INDEX payment_orders_report_lookup
  ON payment_orders(user_id, vin, provider, channel, (coalesce(report_kind, 'korea')));

-- NULL from an already-running legacy writer is Korean, never an unassigned SKU.
-- Normalizing NULL <-> korea is safe; changing an order's product or SKU is not.
CREATE FUNCTION preserve_payment_report_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product IS DISTINCT FROM OLD.product
    OR coalesce(NEW.report_kind, 'korea') IS DISTINCT FROM coalesce(OLD.report_kind, 'korea')
  THEN RAISE EXCEPTION 'Payment product and report kind are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_orders_report_identity
  BEFORE UPDATE OF product, report_kind ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION preserve_payment_report_identity();
SET CONSTRAINTS payment_orders_ledger DEFERRED;
