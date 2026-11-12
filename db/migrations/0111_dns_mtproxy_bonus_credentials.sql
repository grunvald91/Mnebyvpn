BEGIN;

-- One MTProxy/Telemt identity per paid DNS entitlement.
-- Only AES-256-GCM ciphertext is persisted; raw MTProxy secrets never belong
-- in Git, a public website, logging, or a globally shared fallback.
CREATE TABLE IF NOT EXISTS dns_mtproxy_bonus_credentials (
  entitlement_id uuid PRIMARY KEY REFERENCES entitlements(id) ON DELETE CASCADE,
  telemt_username text NOT NULL UNIQUE
    CHECK (telemt_username ~ '^dns_[0-9a-f]{24}$'),
  secret_box text NOT NULL
    CHECK (length(secret_box) BETWEEN 100 AND 512),
  tls_domain text NOT NULL
    CHECK (tls_domain ~ '^[a-z0-9][a-z0-9.-]{2,252}[a-z0-9]$'),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','ACTIVE','DISABLED')),
  verified_at timestamptz,
  disabled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='ACTIVE' AND verified_at IS NOT NULL AND disabled_at IS NULL)
      OR (state <> 'ACTIVE')),
  CHECK ((state='DISABLED' AND disabled_at IS NOT NULL)
      OR (state <> 'DISABLED'))
);

-- Read-only website login may read a credential only after a separate
-- paid-entitlement predicate in the authenticated application. No GRANT to
-- the public brochure DB role or unauthenticated web endpoints.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
    GRANT SELECT ON public.dns_mtproxy_bonus_credentials TO mnebyvpn_site_auth;
  END IF;
END $$;
COMMIT;
