-- Phase 11: an order can initiate at most one Telegram sendInvoice attempt.
-- This is at-most-once dispatch, not guaranteed delivery: ambiguous network
-- outcomes stay UNKNOWN, never silently re-sent. The buyer may create a NEW
-- order explicitly, with rate limits and full precheckout validation.
BEGIN;
CREATE TABLE telegram_invoice_dispatch (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  telegram_user_id bigint NOT NULL CHECK (telegram_user_id > 0),
  state text NOT NULL DEFAULT 'RESERVED'
    CHECK (state IN ('RESERVED','SENT','UNKNOWN')),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((state='RESERVED' AND completed_at IS NULL) OR
         (state IN ('SENT','UNKNOWN') AND completed_at IS NOT NULL))
);
REVOKE ALL ON telegram_invoice_dispatch FROM PUBLIC;
COMMIT;
