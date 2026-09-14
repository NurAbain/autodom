ALTER TABLE payment_orders
  DROP CONSTRAINT payment_orders_kind,
  DROP CONSTRAINT payment_orders_report,
  ADD CONSTRAINT payment_orders_kind CHECK (
    (provider = 'finik' AND currency = 'KGS' AND (
      (product = 'inspection' AND vin IS NULL)
      OR (product = 'vin_report' AND vin IS NOT NULL AND vin ~ '^[A-HJ-NPR-Z0-9]{17}$')
    )) OR (provider = 'telegram_stars' AND product = 'vin_report' AND currency = 'XTR'
      AND vin IS NOT NULL AND vin ~ '^[A-HJ-NPR-Z0-9]{17}$')
  ),
  ADD CONSTRAINT payment_orders_report CHECK (
    (provider = 'finik' AND product = 'inspection' AND payment_status <> 'refunded'
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
    OR (provider = 'finik' AND product = 'vin_report'
      AND pre_checkout_id IS NULL AND report_message_id IS NULL
      AND fulfillment_status NOT IN ('delivering','delivery_unknown')
      AND (payment_status = 'unpaid' OR paid_at IS NOT NULL)
      AND ((fulfillment_status = 'fulfilled' AND report_file_id IS NOT NULL AND delivered_at IS NOT NULL)
        OR (fulfillment_status <> 'fulfilled' AND report_file_id IS NULL AND delivered_at IS NULL))
      AND (admin_notified_at IS NULL OR payment_status <> 'unpaid')
      AND (payment_status <> 'refunded' OR fulfillment_status <> 'ready'))
  );

ALTER TABLE payment_refunds
  ADD COLUMN confirmed_by bigint,
  ADD COLUMN confirmation_reference text,
  DROP CONSTRAINT payment_refunds_kind,
  ADD CONSTRAINT payment_refunds_kind CHECK (
    provider IN ('finik','telegram_stars') AND status IN ('requested','submitted','failed','confirmed')
  ),
  ADD CONSTRAINT payment_refunds_confirmation CHECK (
    (provider = 'finik' AND status = 'confirmed'
      AND confirmed_by BETWEEN 1 AND 9007199254740991 AND confirmed_by IS NOT NULL
      AND confirmation_reference IS NOT NULL AND length(btrim(confirmation_reference)) BETWEEN 1 AND 300)
    OR ((provider <> 'finik' OR status <> 'confirmed')
      AND confirmed_by IS NULL AND confirmation_reference IS NULL)
  );

CREATE TABLE web_report_sessions (
  token_hash text PRIMARY KEY,
  user_id bigint NOT NULL,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  CONSTRAINT web_report_sessions_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT web_report_sessions_buyer CHECK (user_id BETWEEN 1 AND 9007199254740991),
  CONSTRAINT web_report_sessions_expiry_order CHECK (expires_at::timestamptz > created_at::timestamptz)
);
CREATE INDEX web_report_sessions_expiry ON web_report_sessions(expires_at);
