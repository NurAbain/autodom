ALTER TABLE payment_orders ADD COLUMN channel text;
UPDATE payment_orders SET channel = CASE
  WHEN provider = 'finik' AND product = 'vin_report' THEN 'web'
  ELSE 'telegram'
END;
-- Validate the backfill before further DDL; deferred row events otherwise block ALTER TABLE.
SET CONSTRAINTS payment_orders_ledger IMMEDIATE;
ALTER TABLE payment_orders
  ALTER COLUMN channel SET NOT NULL,
  ADD CONSTRAINT payment_orders_channel CHECK (
    channel IN ('telegram','web') AND (channel = 'telegram' OR (provider = 'finik' AND product = 'vin_report'))
  ),
  DROP CONSTRAINT payment_orders_report,
  ADD CONSTRAINT payment_orders_report CHECK (
    (provider = 'finik' AND product = 'inspection' AND payment_status <> 'refunded'
      AND fulfillment_status NOT IN ('delivering','delivery_unknown')
      AND report_file_id IS NULL AND report_message_id IS NULL AND delivered_at IS NULL
      AND admin_notified_at IS NULL AND pre_checkout_id IS NULL)
    OR (product = 'vin_report' AND channel = 'telegram'
      AND ((provider = 'telegram_stars'
        AND (pre_checkout_id IS NULL OR accepted_at IS NOT NULL)
        AND (payment_status = 'unpaid' OR pre_checkout_id IS NOT NULL))
        OR (provider = 'finik' AND pre_checkout_id IS NULL
          AND (payment_status = 'unpaid' OR paid_at IS NOT NULL)))
      AND (fulfillment_status NOT IN ('delivering','delivery_unknown','fulfilled') OR report_file_id IS NOT NULL)
      AND ((fulfillment_status = 'fulfilled' AND report_message_id BETWEEN 1 AND 9007199254740991
        AND report_message_id IS NOT NULL AND delivered_at IS NOT NULL)
        OR (fulfillment_status <> 'fulfilled' AND report_message_id IS NULL AND delivered_at IS NULL))
      AND (admin_notified_at IS NULL OR payment_status <> 'unpaid')
      AND (payment_status <> 'refunded' OR fulfillment_status <> 'ready'))
    OR (provider = 'finik' AND product = 'vin_report' AND channel = 'web'
      AND pre_checkout_id IS NULL AND report_message_id IS NULL
      AND fulfillment_status NOT IN ('delivering','delivery_unknown')
      AND (payment_status = 'unpaid' OR paid_at IS NOT NULL)
      AND ((fulfillment_status = 'fulfilled' AND report_file_id IS NOT NULL AND delivered_at IS NOT NULL)
        OR (fulfillment_status <> 'fulfilled' AND report_file_id IS NULL AND delivered_at IS NULL))
      AND (admin_notified_at IS NULL OR payment_status <> 'unpaid')
      AND (payment_status <> 'refunded' OR fulfillment_status <> 'ready'))
  );
CREATE INDEX payment_orders_report_lookup ON payment_orders(user_id, vin, provider, channel);

CREATE OR REPLACE FUNCTION validate_payment_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
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
        OR ((o.provider = 'telegram_stars' OR (o.provider = 'finik' AND o.product = 'vin_report' AND o.channel = 'telegram')) AND (r.amount <> o.amount
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
SET CONSTRAINTS payment_orders_ledger DEFERRED;
