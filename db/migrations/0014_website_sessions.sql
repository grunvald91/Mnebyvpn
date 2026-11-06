-- Phase 14: server-side revocable website sessions.
-- Only a SHA-256 digest is stored; raw bearer tokens never touch the DB.
BEGIN;
CREATE TABLE website_sessions (
  token_sha256 text PRIMARY KEY CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK(expires_at>created_at)
);
CREATE INDEX website_sessions_account_idx ON website_sessions(account_id,expires_at DESC);
CREATE INDEX website_sessions_expired_idx ON website_sessions(expires_at);
REVOKE ALL ON website_sessions FROM PUBLIC;
COMMIT;
