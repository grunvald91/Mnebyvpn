-- Authenticated email-code sign-in and best-effort same-browser trial throttling.
-- Device cookies can be deleted/spoofed: this DOES NOT promise per-physical-device uniqueness.
BEGIN;
ALTER TABLE accounts ADD COLUMN email_address varchar(254) UNIQUE
  CHECK (email_address IS NULL OR (length(email_address)>=6 AND email_address=lower(email_address)));

CREATE TABLE web_email_codes (
  email varchar(254) PRIMARY KEY,
  code_hash char(64) NOT NULL CHECK(code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  link_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT
);
CREATE INDEX web_email_codes_expired ON web_email_codes(expires_at);
CREATE TABLE web_email_rate_limits (
  subject_hash char(64) PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0)
);
CREATE TABLE trial_device_claims (
  device_hash char(64) PRIMARY KEY CHECK(device_hash ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX trial_device_claims_account ON trial_device_claims(account_id);
REVOKE ALL ON web_email_codes,web_email_rate_limits,trial_device_claims FROM PUBLIC;
COMMIT;
