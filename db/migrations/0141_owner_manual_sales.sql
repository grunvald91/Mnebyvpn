-- Owner-attested personal sales. No PSP capture, webhook or fabricated provider event.
-- A Telegram @username is an operator-facing label, NOT authenticated identity.
BEGIN;
CREATE TABLE manual_sales (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  operator_telegram_id bigint NOT NULL CHECK (operator_telegram_id > 0),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 120),
  customer_label text NOT NULL CHECK (customer_label ~ '^[a-z][a-z0-9_]{4,31}$'),
  declared_amount_minor bigint NOT NULL CHECK (declared_amount_minor BETWEEN 1 AND 10000000),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  receipt_reference text CHECK (receipt_reference IS NULL OR length(receipt_reference) BETWEEN 4 AND 80),
  dns_label_ciphertext text CHECK (dns_label_ciphertext IS NULL OR length(dns_label_ciphertext) BETWEEN 40 AND 300),
  UNIQUE (operator_telegram_id, request_key)
);
CREATE INDEX manual_sales_owner_recent_idx
  ON manual_sales(operator_telegram_id, recorded_at DESC);
CREATE INDEX manual_sales_customer_idx
  ON manual_sales(operator_telegram_id, customer_label);
REVOKE ALL ON manual_sales FROM PUBLIC;
-- This table records an owner's report of money received, not independent
-- confirmation from a provider or proof of fiscal receipt issuance.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnebyvpn_bot') THEN
    GRANT SELECT, INSERT, UPDATE(dns_label_ciphertext) ON manual_sales TO mnebyvpn_bot;
  END IF;
END
$grants$;
COMMIT;
