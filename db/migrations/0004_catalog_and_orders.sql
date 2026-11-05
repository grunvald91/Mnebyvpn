-- Phase 4: trusted catalog and immutable order terms; no server deployment.
BEGIN;
CREATE TABLE billing_plans (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  product text NOT NULL CHECK (product IN ('vpn','smart_dns','bundle')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 128),
  duration_seconds bigint NOT NULL CHECK (duration_seconds BETWEEN 1 AND 315360000),
  dns_quota_bytes bigint CHECK (dns_quota_bytes > 0),
  rub_minor bigint CHECK (rub_minor > 0),
  stars bigint CHECK (stars > 0),
  enabled boolean NOT NULL DEFAULT false,
  CHECK (rub_minor IS NOT NULL OR stars IS NOT NULL),
  CHECK ((product = 'vpn' AND dns_quota_bytes IS NULL)
     OR (product IN ('smart_dns','bundle') AND dns_quota_bytes IS NOT NULL))
);
-- Admin-only writes. No public prices, quotas or live products are invented.
CREATE TABLE order_terms (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  plan_id text NOT NULL REFERENCES billing_plans(id) ON DELETE RESTRICT,
  plan_title text NOT NULL,
  duration_seconds bigint NOT NULL CHECK (duration_seconds > 0),
  dns_quota_bytes bigint CHECK (dns_quota_bytes > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A Telegram update may be delivered repeatedly; prevent duplicate orders.
CREATE TABLE checkout_requests (
  channel text NOT NULL CHECK (channel IN ('telegram_stars','prodamus')),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 160),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  PRIMARY KEY (channel, request_id)
);
CREATE INDEX reconcile_outbox_unhandled_idx ON reconcile_outbox (id)
  WHERE handled_at IS NULL;
-- Disallow plan mutation of already paid orders: snapshots stay independent.
CREATE FUNCTION protect_order_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable order terms';
END;
$$;
CREATE TRIGGER block_order_terms_update
  BEFORE UPDATE OR DELETE ON order_terms
  FOR EACH ROW EXECUTE FUNCTION protect_order_terms();
REVOKE ALL ON billing_plans FROM PUBLIC;
REVOKE ALL ON order_terms FROM PUBLIC;
REVOKE ALL ON checkout_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_order_terms() FROM PUBLIC;
COMMIT;
