-- Phase 5: durable retry scheduling. Never touches any data-plane/server.
BEGIN;
ALTER TABLE reconcile_outbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE reconcile_outbox ADD COLUMN last_error_code text;
CREATE INDEX reconcile_outbox_due_idx
  ON reconcile_outbox(next_attempt_at,id) WHERE handled_at IS NULL;

-- Each verified provider refund is applied by apply_verified_refund() from 0002.
-- No public client may insert a payment verification or call refund SQL directly.
REVOKE ALL ON reconcile_outbox FROM PUBLIC;
REVOKE ALL ON provisioning_state FROM PUBLIC;
COMMIT;
