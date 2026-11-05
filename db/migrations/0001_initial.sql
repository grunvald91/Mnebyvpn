-- MNEBYVPN business schema. Separate database/role from Remnawave upstream.
-- Apply manually to an isolated PostgreSQL test database; never to a live VPS by default.
BEGIN;

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  telegram_user_id bigint UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  product text NOT NULL CHECK (product IN ('vpn', 'smart_dns', 'bundle')),
  provider text,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'PAID', 'REFUNDED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Only trusted, verified payment-provider adapters may insert these events.
CREATE TABLE verified_payment_events (
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  order_id uuid NOT NULL REFERENCES orders(id),
  verified_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (provider, provider_event_id)
);

CREATE TABLE entitlements (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  source_order_id uuid NOT NULL REFERENCES orders(id),
  product text NOT NULL CHECK (product IN ('vpn', 'smart_dns')),
  state text NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (state IN (
    'PENDING_PAYMENT', 'PAID_PENDING_PROVISIONING', 'PROVISIONING_FAILED',
    'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED', 'REFUNDED'
  )),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  starts_at timestamptz,
  expires_at timestamptz,
  quota_limit_bytes bigint CHECK (quota_limit_bytes >= 0),
  quota_used_bytes bigint NOT NULL DEFAULT 0 CHECK (quota_used_bytes >= 0),
  quota_state text NOT NULL DEFAULT 'AVAILABLE' CHECK (quota_state IN ('AVAILABLE', 'EXHAUSTED')),
  CHECK (quota_limit_bytes IS NULL OR quota_used_bytes <= quota_limit_bytes),
  CHECK (product <> 'smart_dns' OR quota_limit_bytes IS NOT NULL),
  UNIQUE (source_order_id, product),
  CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX entitlements_account_idx ON entitlements (account_id);

-- Contains signals, not executable stale ENABLE commands.
CREATE TABLE reconcile_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entitlement_id uuid NOT NULL REFERENCES entitlements(id),
  desired_revision bigint NOT NULL CHECK (desired_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  UNIQUE (entitlement_id, desired_revision)
);

CREATE TABLE provisioning_state (
  entitlement_id uuid NOT NULL REFERENCES entitlements(id),
  adapter text NOT NULL CHECK (adapter IN ('vpn', 'smart_dns')),
  applied_revision bigint NOT NULL DEFAULT 0 CHECK (applied_revision >= 0),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  last_observed_at timestamptz,
  PRIMARY KEY (entitlement_id, adapter)
);

-- Idempotent metering events; never store raw client IP/DNS history here.
CREATE TABLE quota_usage_events (
  entitlement_id uuid NOT NULL REFERENCES entitlements(id),
  usage_event_id text NOT NULL CHECK (length(usage_event_id) BETWEEN 1 AND 128),
  bytes bigint NOT NULL CHECK (bytes > 0),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entitlement_id, usage_event_id)
);

-- Atomic shared-bucket charging: concurrent calls serialize via row lock.
-- This is a ledger primitive, NOT proof of on-wire enforcement or hard cap
-- until a real ingress authenticates each flow and pre-authorizes each chunk.
CREATE FUNCTION debit_smart_dns_quota(
  p_entitlement_id uuid, p_usage_event_id text, p_bytes bigint
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  current_entitlement entitlements%ROWTYPE;
  is_exhausted boolean;
BEGIN
  IF p_bytes IS NULL OR p_bytes <= 0 OR
     p_usage_event_id IS NULL OR length(p_usage_event_id) NOT BETWEEN 1 AND 128 THEN
    RETURN 'DENY_INVALID';
  END IF;

  SELECT * INTO current_entitlement FROM entitlements
   WHERE id = p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;

  IF EXISTS (SELECT 1 FROM quota_usage_events
             WHERE entitlement_id = p_entitlement_id AND usage_event_id = p_usage_event_id) THEN
    RETURN 'DUPLICATE';
  END IF;

  IF current_entitlement.product <> 'smart_dns'
     OR current_entitlement.state <> 'ACTIVE'
     OR current_entitlement.expires_at IS NULL
     OR current_entitlement.expires_at <= clock_timestamp()
     OR current_entitlement.quota_state <> 'AVAILABLE' THEN
    RETURN 'DENY_INACTIVE';
  END IF;

  IF p_bytes > current_entitlement.quota_limit_bytes - current_entitlement.quota_used_bytes THEN
    RETURN 'DENY_QUOTA';
  END IF;

  is_exhausted := p_bytes = current_entitlement.quota_limit_bytes - current_entitlement.quota_used_bytes;
  UPDATE entitlements SET
    quota_used_bytes = quota_used_bytes + p_bytes,
    quota_state = CASE WHEN is_exhausted THEN 'EXHAUSTED' ELSE quota_state END,
    revision = revision + CASE WHEN is_exhausted THEN 1 ELSE 0 END
   WHERE id = p_entitlement_id;
  INSERT INTO quota_usage_events(entitlement_id, usage_event_id, bytes)
    VALUES(p_entitlement_id, p_usage_event_id, p_bytes);
  IF is_exhausted THEN
    INSERT INTO reconcile_outbox(entitlement_id, desired_revision)
      SELECT id, revision FROM entitlements WHERE id = p_entitlement_id
      ON CONFLICT (entitlement_id, desired_revision) DO NOTHING;
  END IF;
  RETURN 'ACCEPTED';
END;
$$;

COMMIT;
