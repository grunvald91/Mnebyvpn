-- Durable, separately retryable customer notices after provider-confirmed payment.
-- The queue must never be used as evidence of payment or network activation.
BEGIN;
CREATE TABLE vpn_purchase_notifications (
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('PAYMENT','READY')),
  telegram_user_id text NOT NULL CHECK(telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SENDING','SENT','FAILED','SKIPPED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_until timestamptz,
  sent_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 40),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (order_id,kind),
  CHECK (sent_at IS NULL OR status='SENT')
);
CREATE INDEX vpn_purchase_notifications_pending_idx
  ON vpn_purchase_notifications(next_attempt_at)
  WHERE status IN ('PENDING','SENDING');
REVOKE ALL ON vpn_purchase_notifications FROM PUBLIC;
COMMIT;
