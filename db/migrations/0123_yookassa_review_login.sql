-- One ordinary account may use a permanent reviewer code instead of email OTP.
-- Credentials are provisioned privately after migration, never seeded in Git.
BEGIN;
CREATE TABLE web_review_login (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
  email varchar(254) NOT NULL UNIQUE,
  code_salt char(32) NOT NULL CHECK(code_salt ~ '^[a-f0-9]{32}$'),
  code_hash char(64) NOT NULL CHECK(code_hash ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON web_review_login FROM PUBLIC;
-- The production website uses the canonical least-privilege authentication role.
-- It may verify credentials and update ONLY lockout counters, not change the code,
-- target account, email, or activation flag.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
    GRANT SELECT ON web_review_login TO mnebyvpn_site_auth;
    GRANT UPDATE (failed_attempts,locked_until) ON web_review_login TO mnebyvpn_site_auth;
  END IF;
END $$;
COMMIT;
