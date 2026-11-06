-- Durable reminders for active VPN entitlement expiry, not draft orders.
-- The same subscription can have multiple future expiry deadlines after renewals.
BEGIN;
CREATE TABLE vpn_expiry_reminders (
  entitlement_id uuid NOT NULL REFERENCES entitlements(id) ON DELETE RESTRICT,
  days_before smallint NOT NULL CHECK(days_before IN (3,1)),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','SENDING','SENT','SKIPPED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_until timestamptz,
  sent_at timestamptz,
  last_error_code text CHECK(last_error_code IS NULL OR length(last_error_code)<=40),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(entitlement_id,days_before,expires_at),
  CHECK(sent_at IS NULL OR status='SENT')
);
CREATE INDEX vpn_expiry_reminders_queue_idx
  ON vpn_expiry_reminders(next_attempt_at)
  WHERE status IN ('PENDING','SENDING');
REVOKE ALL ON vpn_expiry_reminders FROM PUBLIC;
COMMIT;
