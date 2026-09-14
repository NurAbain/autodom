ALTER TABLE payment_orders
  ADD COLUMN vin text,
  ADD COLUMN paid_at text,
  ADD COLUMN report_file_id text,
  ADD COLUMN report_message_id bigint,
  ADD COLUMN delivered_at text,
  ADD COLUMN admin_notified_at text,
  ADD COLUMN pre_checkout_id text;

ALTER TABLE payment_orders
  DROP CONSTRAINT payment_orders_kind,
  DROP CONSTRAINT payment_orders_amount,
  DROP CONSTRAINT payment_orders_state,
  DROP CONSTRAINT payment_orders_capture,
  DROP CONSTRAINT payment_orders_fulfillment,
  ADD CONSTRAINT payment_orders_kind CHECK (
    (provider = 'finik' AND product = 'inspection' AND currency = 'KGS' AND vin IS NULL)
    OR (provider = 'telegram_stars' AND product = 'vin_report' AND currency = 'XTR'
      AND vin IS NOT NULL AND vin ~ '^[A-HJ-NPR-Z0-9]{17}$')
  ),
  ADD CONSTRAINT payment_orders_amount CHECK (
    amount BETWEEN 1 AND 9007199254740991 AND (provider <> 'finik' OR amount % 100 = 0)
  ),
  ADD CONSTRAINT payment_orders_state CHECK (
    invoice_status IN ('offered','pending','cancelled')
    AND payment_status IN ('unpaid','paid','refunded')
    AND fulfillment_status IN ('ready','delivering','delivery_unknown','fulfilled','cancelled')
  ),
  ADD CONSTRAINT payment_orders_capture CHECK (
    (payment_status = 'unpaid' AND charge_id IS NULL AND paid_at IS NULL)
    OR (payment_status IN ('paid','refunded') AND charge_id IS NOT NULL
      AND accepted_at IS NOT NULL AND (provider = 'finik' OR paid_at IS NOT NULL))
  ),
  ADD CONSTRAINT payment_orders_fulfillment CHECK (
    fulfillment_status NOT IN ('fulfilled','delivering','delivery_unknown')
    OR payment_status IN ('paid','refunded')
  ),
  ADD CONSTRAINT payment_orders_report CHECK (
    (provider = 'finik' AND payment_status <> 'refunded'
      AND fulfillment_status NOT IN ('delivering','delivery_unknown')
      AND report_file_id IS NULL AND report_message_id IS NULL AND delivered_at IS NULL
      AND admin_notified_at IS NULL AND pre_checkout_id IS NULL)
    OR (provider = 'telegram_stars'
      AND (pre_checkout_id IS NULL OR accepted_at IS NOT NULL)
      AND (payment_status = 'unpaid' OR pre_checkout_id IS NOT NULL)
      AND (fulfillment_status NOT IN ('delivering','delivery_unknown','fulfilled') OR report_file_id IS NOT NULL)
      AND ((fulfillment_status = 'fulfilled' AND report_message_id BETWEEN 1 AND 9007199254740991
        AND report_message_id IS NOT NULL AND delivered_at IS NOT NULL)
        OR (fulfillment_status <> 'fulfilled' AND report_message_id IS NULL AND delivered_at IS NULL))
      AND (admin_notified_at IS NULL OR payment_status <> 'unpaid')
      AND (payment_status <> 'refunded' OR fulfillment_status <> 'ready'))
  );
CREATE UNIQUE INDEX payment_orders_pre_checkout ON payment_orders(pre_checkout_id);

ALTER TABLE payment_events DROP CONSTRAINT payment_events_provider,
  ADD CONSTRAINT payment_events_provider CHECK (provider IN ('finik','telegram_stars'));
CREATE UNIQUE INDEX payment_events_applied_charge_kind
  ON payment_events(provider, charge_id, (data->>'kind')) WHERE outcome = 'applied';

ALTER TABLE payment_refunds DROP CONSTRAINT payment_refunds_kind,
  ADD CONSTRAINT payment_refunds_kind CHECK (
    (provider = 'finik' AND status IN ('requested','submitted','failed'))
    OR (provider = 'telegram_stars' AND status IN ('requested','submitted','failed','confirmed'))
  );
DROP INDEX payment_refunds_active;
CREATE UNIQUE INDEX payment_refunds_active ON payment_refunds(order_id)
  WHERE status = 'requested' OR (provider = 'telegram_stars' AND status IN ('submitted','confirmed'));

-- Commit-time checks allow capture and its receipt to be written in either order,
-- but never allow a paid flag or refund allocation without its financial evidence.
CREATE FUNCTION validate_payment_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_key text;
  old_key text;
  new_key text;
  o payment_orders%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_TABLE_NAME = 'payment_orders' THEN old_key := OLD.id;
    ELSE old_key := OLD.order_id; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'payment_orders' THEN new_key := NEW.id;
    ELSE new_key := NEW.order_id; END IF;
  END IF;
  FOR order_key IN SELECT DISTINCT key FROM unnest(ARRAY[old_key, new_key]) AS keys(key) WHERE key IS NOT NULL LOOP
    SELECT * INTO o FROM payment_orders WHERE id = order_key;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF o.payment_status IN ('paid','refunded') AND NOT EXISTS (
      SELECT 1 FROM payment_events e WHERE e.order_id = o.id AND e.provider = o.provider
        AND e.charge_id = o.charge_id AND e.data->>'kind' = 'paid'
        AND e.data->>'currency' = o.currency AND (e.data->>'amount')::numeric = o.amount
        AND (o.provider = 'finik' OR (e.data->>'userId')::numeric = o.user_id)
        AND (o.paid_at IS NULL OR (e.data->>'occurredAt')::timestamptz = o.paid_at::timestamptz)
        AND (e.outcome = 'applied' OR e.review_reason = 'late_or_cancelled_payment')
    ) THEN RAISE EXCEPTION 'Captured payment requires a matching receipt'; END IF;
    IF EXISTS (
      SELECT 1 FROM payment_refunds r WHERE r.order_id = o.id
      GROUP BY r.order_id HAVING o.payment_status NOT IN ('paid','refunded')
        OR sum(CASE WHEN r.status <> 'failed' THEN r.amount ELSE 0 END) > o.amount
        OR max(r.amount) > o.amount
    ) OR EXISTS (
      SELECT 1 FROM payment_refunds r WHERE r.order_id = o.id AND (
        r.provider <> o.provider OR (r.status = 'confirmed' AND o.payment_status <> 'refunded')
        OR (o.provider = 'telegram_stars' AND (r.amount <> o.amount
          OR (r.status IN ('requested','submitted')
            AND (o.payment_status = 'refunded' OR o.fulfillment_status = 'delivering'))))
      )
    ) THEN RAISE EXCEPTION 'Invalid payment refund allocation'; END IF;
    IF o.payment_status = 'refunded' AND NOT EXISTS (
      SELECT 1 FROM payment_events e WHERE e.order_id = o.id AND e.provider = o.provider
        AND e.charge_id = o.charge_id AND e.data->>'kind' = 'refunded' AND e.outcome = 'applied'
        AND e.data->>'currency' = o.currency AND (e.data->>'amount')::numeric = o.amount
        AND (e.data->>'userId')::numeric = o.user_id
    ) AND NOT EXISTS (
      SELECT 1 FROM payment_refunds r WHERE r.order_id = o.id AND r.provider = o.provider
        AND r.status = 'confirmed' AND r.amount = o.amount
    ) THEN RAISE EXCEPTION 'Refund requires confirmed provider evidence'; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER payment_orders_ledger
  AFTER INSERT OR UPDATE OR DELETE ON payment_orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_payment_ledger();
CREATE CONSTRAINT TRIGGER payment_events_ledger
  AFTER INSERT OR UPDATE OR DELETE ON payment_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_payment_ledger();
CREATE CONSTRAINT TRIGGER payment_refunds_ledger
  AFTER INSERT OR UPDATE OR DELETE ON payment_refunds DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_payment_ledger();
