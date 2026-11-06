-- Phase 12: durable incidents for authenticated payment captures that cannot
-- be settled. Never acknowledge an unauthenticated Prodamus notification.
BEGIN;
CREATE TABLE payment_incidents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK(provider IN ('telegram_stars','prodamus')),
  transaction_hash text NOT NULL CHECK(transaction_hash ~ '^[a-f0-9]{64}
  order_id uuid,
  actor_telegram_user_id bigint,
  amount_minor bigint CHECK(amount_minor>=0),
  currency text CHECK(currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL CHECK(reason ~ '^[A-Z_]{3,64}$'),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sightings integer NOT NULL DEFAULT 1,
  alerted_at timestamptz,
  resolved_at timestamptz,
  UNIQUE(provider,transaction_hash)
);
CREATE INDEX payment_incidents_pending_alert_idx
 ON payment_incidents(id) WHERE alerted_at IS NULL AND resolved_at IS NULL;
REVOKE ALL ON payment_incidents FROM PUBLIC;
COMMIT;
),
  -- Sensitive reconciliation key: never log or send via Telegram alert.
  transaction_id text NOT NULL CHECK(length(transaction_id) BETWEEN 1 AND 512),
  order_id uuid,
  actor_telegram_user_id bigint,
  amount_minor bigint CHECK(amount_minor>=0),
  currency text CHECK(currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL CHECK(reason ~ '^[A-Z_]{3,64}$'),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sightings integer NOT NULL DEFAULT 1,
  alerted_at timestamptz,
  resolved_at timestamptz,
  UNIQUE(provider,transaction_hash)
);
CREATE INDEX payment_incidents_pending_alert_idx
 ON payment_incidents(id) WHERE alerted_at IS NULL AND resolved_at IS NULL;
REVOKE ALL ON payment_incidents FROM PUBLIC;
COMMIT;
