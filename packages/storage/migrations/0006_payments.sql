CREATE TABLE payment_orders (
  id text PRIMARY KEY,
  user_id bigint NOT NULL,
  product text NOT NULL,
  provider text NOT NULL,
  currency text NOT NULL,
  amount bigint NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  seller text NOT NULL,
  support_url text NOT NULL,
  terms text NOT NULL,
  executor text NOT NULL,
  expires_at text NOT NULL,
  created_at text NOT NULL,
  accepted_at text,
  invoice_url text,
  invoice_status text NOT NULL,
  payment_status text NOT NULL,
  fulfillment_status text NOT NULL,
  charge_id text,
  needs_review boolean NOT NULL,
  CONSTRAINT payment_orders_kind CHECK (provider = 'finik' AND product = 'inspection' AND currency = 'KGS'),
  CONSTRAINT payment_orders_amount CHECK (amount BETWEEN 1 AND 9007199254740991 AND amount % 100 = 0),
  CONSTRAINT payment_orders_buyer_id CHECK (user_id BETWEEN 1 AND 9007199254740991),
  CONSTRAINT payment_orders_state CHECK (invoice_status IN ('offered','pending','cancelled') AND payment_status IN ('unpaid','paid') AND fulfillment_status IN ('ready','fulfilled','cancelled')),
  CONSTRAINT payment_orders_capture CHECK ((payment_status = 'unpaid' AND charge_id IS NULL) OR (payment_status = 'paid' AND charge_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CONSTRAINT payment_orders_fulfillment CHECK (fulfillment_status <> 'fulfilled' OR payment_status = 'paid')
);
CREATE INDEX payment_orders_buyer ON payment_orders(user_id, created_at);
CREATE UNIQUE INDEX payment_orders_charge ON payment_orders(provider, charge_id);

-- No order FK: authenticated receipts for unknown merchant IDs are still financial audit.
CREATE TABLE payment_events (
  id text PRIMARY KEY,
  provider text NOT NULL,
  event_id text NOT NULL,
  charge_id text NOT NULL,
  order_id text,
  fingerprint text NOT NULL,
  data jsonb NOT NULL,
  outcome text NOT NULL,
  review_reason text,
  received_at text NOT NULL,
  CONSTRAINT payment_events_provider CHECK (provider = 'finik'),
  CONSTRAINT payment_events_outcome CHECK ((outcome = 'applied' AND review_reason IS NULL) OR (outcome = 'review' AND review_reason IS NOT NULL))
);
CREATE UNIQUE INDEX payment_events_fingerprint ON payment_events(fingerprint);
CREATE INDEX payment_events_transaction ON payment_events(provider, event_id);
CREATE INDEX payment_events_charge ON payment_events(provider, charge_id);

CREATE TABLE payment_refunds (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES payment_orders(id),
  provider text NOT NULL,
  amount bigint NOT NULL,
  reason text NOT NULL,
  status text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  note text,
  CONSTRAINT payment_refunds_kind CHECK (provider = 'finik' AND status IN ('requested','submitted','failed')),
  CONSTRAINT payment_refunds_amount CHECK (amount BETWEEN 1 AND 9007199254740991)
);
CREATE INDEX payment_refunds_order ON payment_refunds(order_id);
CREATE UNIQUE INDEX payment_refunds_active ON payment_refunds(order_id) WHERE status = 'requested';
