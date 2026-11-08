-- Automatic Telegram delivery of *verified* free VPN trial activation.
-- A trial is eligible only after the foreign VPN node has acknowledged the
-- final provisioning revision and the trial clock is already running.
BEGIN;
CREATE TABLE vpn_trial_ready_notifications (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  telegram_user_id text NOT NULL CHECK (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SENDING','SENT','FAILED','SKIPPED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_until timestamptz,
  sent_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code)<=40),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (sent_at IS NULL OR status='SENT')
);
CREATE INDEX vpn_trial_ready_notifications_due_idx
  ON vpn_trial_ready_notifications(next_attempt_at)
  WHERE status IN ('PENDING','SENDING');
REVOKE ALL ON vpn_trial_ready_notifications FROM PUBLIC;
COMMIT;
