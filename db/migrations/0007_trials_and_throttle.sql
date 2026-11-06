-- Phase 8: one-day trial reservation, explicit paid checkout throttling.
-- Commercial prices remain admin-configured; never seed invented paid prices.
BEGIN;

ALTER TABLE orders DROP CONSTRAINT orders_state_check;
ALTER TABLE orders ADD CONSTRAINT orders_state_check
  CHECK (state IN ('PENDING','PAID','REFUNDED','CANCELLED','TRIAL'));

CREATE TABLE trial_offers (
  product text PRIMARY KEY CHECK (product IN ('vpn','smart_dns','bundle')),
  duration_seconds bigint NOT NULL DEFAULT 86400 CHECK (duration_seconds=86400),
  dns_quota_bytes bigint CHECK (dns_quota_bytes>0),
  enabled boolean NOT NULL DEFAULT false,
  CHECK (
    (product='vpn' AND dns_quota_bytes IS NULL) OR
    (product IN ('smart_dns','bundle') AND
       (enabled=false OR dns_quota_bytes IS NOT NULL))
  )
);
-- VPN trial can be prepared without inventing a DNS traffic quota.
-- Disable before public launch if VPN nodes/entitlement expiry aren't verified.
INSERT INTO trial_offers(product,duration_seconds,enabled)
  VALUES ('vpn',86400,false),('smart_dns',86400,false),('bundle',86400,false);

CREATE TABLE trial_grants (
  telegram_user_id bigint PRIMARY KEY CHECK (telegram_user_id>0),
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  product text NOT NULL REFERENCES trial_offers(product) ON DELETE RESTRICT,
  invite_token text REFERENCES referral_invites(token) ON DELETE RESTRICT,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX trial_grants_account_idx ON trial_grants(account_id);
CREATE INDEX pending_orders_account_recent_idx
  ON orders(account_id,created_at DESC)
  WHERE state='PENDING';
REVOKE ALL ON trial_offers FROM PUBLIC;
REVOKE ALL ON trial_grants FROM PUBLIC;
COMMIT;
