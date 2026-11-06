-- Offline development: execute only after 0001 on a dedicated TEST database.
-- These functions are intentionally not granted to PUBLIC. A narrowly scoped
-- trusted billing / provisioning role must be configured before deployment.
-- No network, VPN, DNS, or provider access is performed by this migration.
BEGIN;

ALTER TABLE verified_payment_events
  ADD COLUMN event_kind text NOT NULL DEFAULT 'PAID'
  CHECK (event_kind IN ('PAID', 'REFUND'));

-- Provider capture identity is different from webhook event identity. This
-- prevents a single captured transaction from funding two separate orders.
CREATE TABLE provider_captures (
  provider text NOT NULL,
  transaction_id text NOT NULL CHECK (length(transaction_id) BETWEEN 1 AND 160),
  order_id uuid NOT NULL REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, transaction_id),
  UNIQUE (order_id)
);

-- Do not treat delivery payload hash (including Prodamus attempt) as payment identity.
CREATE TABLE payment_delivery_receipts (
  provider text NOT NULL,
  transaction_id text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('PAID', 'REFUND')),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  deliveries bigint NOT NULL DEFAULT 1 CHECK (deliveries > 0),
  PRIMARY KEY(provider, transaction_id, event_kind, payload_sha256)
);

CREATE FUNCTION record_payment_delivery(
  p_provider text, p_transaction_id text, p_kind text, p_payload_sha256 text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO payment_delivery_receipts (provider, transaction_id, event_kind, payload_sha256)
    VALUES (p_provider, p_transaction_id, p_kind, p_payload_sha256)
    ON CONFLICT(provider, transaction_id, event_kind, payload_sha256)
      DO UPDATE SET last_seen_at = clock_timestamp(),
                    deliveries = payment_delivery_receipts.deliveries + 1;
END;
$$;

-- Only call AFTER verification of webhook signature AND independent provider
-- status lookup. Amount, currency, duration, quota and product MUST come from
-- trusted server-side order/plan data, not user-supplied webhook fields.
CREATE FUNCTION settle_verified_payment(
  p_order_id uuid,
  p_provider text,
  p_provider_event_id text,
  p_provider_transaction_id text,
  p_payload_sha256 text,
  p_amount_minor bigint,
  p_currency text,
  p_duration_seconds bigint,
  p_dns_quota_bytes bigint
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  o orders%ROWTYPE;
  v_start timestamptz := clock_timestamp();
  v_product text;
  v_id uuid;
  v_rows int;
  v_existing verified_payment_events%ROWTYPE;
BEGIN
  IF p_order_id IS NULL OR p_provider IS NULL OR p_provider = ''
     OR p_provider_event_id IS NULL OR p_provider_event_id = ''
     OR p_provider_transaction_id IS NULL OR length(p_provider_transaction_id) NOT BETWEEN 1 AND 160
     OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[a-f0-9]{64}$'
     OR p_duration_seconds IS NULL OR p_duration_seconds <= 0
     OR p_duration_seconds > 315360000 -- max 10 years; actual plan is stricter
     OR p_amount_minor IS NULL OR p_amount_minor < 0
     OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN
    RETURN 'DENY_INVALID';
  END IF;

  SELECT * INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN_ORDER'; END IF;
  IF o.provider IS DISTINCT FROM p_provider OR o.amount_minor <> p_amount_minor
     OR o.currency <> p_currency THEN RETURN 'DENY_MISMATCH'; END IF;

  SELECT * INTO v_existing FROM verified_payment_events
    WHERE provider = p_provider AND provider_event_id = p_provider_event_id;
  IF FOUND THEN
    IF v_existing.order_id = p_order_id AND v_existing.event_kind = 'PAID'
       AND o.state IN ('PAID', 'REFUNDED') AND EXISTS (
         SELECT 1 FROM provider_captures
          WHERE provider = p_provider AND transaction_id = p_provider_transaction_id
            AND order_id = p_order_id
       ) THEN
      PERFORM record_payment_delivery(p_provider, p_provider_transaction_id, 'PAID', p_payload_sha256);
      RETURN 'DUPLICATE_EVENT';
    END IF;
    RETURN 'DENY_EVENT_REUSED';
  END IF;

  -- A provider can redeliver the same captured payment under another event ID.
  IF EXISTS (SELECT 1 FROM provider_captures
             WHERE provider = p_provider AND transaction_id = p_provider_transaction_id) THEN
    IF EXISTS (SELECT 1 FROM provider_captures
               WHERE provider = p_provider AND transaction_id = p_provider_transaction_id
                 AND order_id = p_order_id)
       AND o.state IN ('PAID', 'REFUNDED') THEN
      PERFORM record_payment_delivery(p_provider, p_provider_transaction_id, 'PAID', p_payload_sha256);
      RETURN 'DUPLICATE_CAPTURE';
    END IF;
    RETURN 'DENY_CAPTURE_REUSED';
  END IF;

  IF o.state <> 'PENDING' THEN RETURN 'DENY_ORDER_ALREADY_SETTLED'; END IF;
  IF o.product IN ('smart_dns', 'bundle') AND
     (p_dns_quota_bytes IS NULL OR p_dns_quota_bytes <= 0) THEN
    RETURN 'DENY_QUOTA_INVALID';
  END IF;
  IF o.product = 'vpn' AND p_dns_quota_bytes IS NOT NULL THEN
    RETURN 'DENY_QUOTA_INVALID';
  END IF;

  INSERT INTO provider_captures(provider, transaction_id, order_id)
    VALUES(p_provider, p_provider_transaction_id, p_order_id)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RETURN 'DENY_CAPTURE_REUSED'; END IF;

  INSERT INTO verified_payment_events(provider, provider_event_id, order_id,
                                      verified_at, payload_sha256, event_kind)
    VALUES (p_provider, p_provider_event_id, p_order_id,
            v_start, p_payload_sha256, 'PAID');
  PERFORM record_payment_delivery(p_provider, p_provider_transaction_id, 'PAID', p_payload_sha256);
  UPDATE orders SET state = 'PAID' WHERE id = p_order_id;

  FOREACH v_product IN ARRAY CASE WHEN o.product = 'bundle'
      THEN ARRAY['vpn', 'smart_dns'] ELSE ARRAY[o.product] END
  LOOP
    v_id := gen_random_uuid();
    INSERT INTO entitlements(id, account_id, source_order_id, product,
      state, revision, starts_at, expires_at, quota_limit_bytes)
    VALUES(v_id, o.account_id, p_order_id, v_product,
      'PAID_PENDING_PROVISIONING', 1, v_start,
      v_start + make_interval(secs => p_duration_seconds::double precision),
      CASE WHEN v_product = 'smart_dns' THEN p_dns_quota_bytes ELSE NULL END);
    INSERT INTO reconcile_outbox(entitlement_id, desired_revision)
      VALUES(v_id, 1);
  END LOOP;
  RETURN 'APPLIED';
END;
$$;

-- Only call AFTER a verified provider refund/chargeback result for the capture.
-- Refund is idempotent and invalidates both products in a bundle atomically.
CREATE FUNCTION apply_verified_refund(
  p_order_id uuid, p_provider text, p_provider_event_id text,
  p_provider_transaction_id text, p_payload_sha256 text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  o orders%ROWTYPE;
  v_existing verified_payment_events%ROWTYPE;
BEGIN
  IF p_order_id IS NULL OR p_provider IS NULL OR p_provider = ''
     OR p_provider_event_id IS NULL OR p_provider_event_id = ''
     OR p_provider_transaction_id IS NULL OR p_provider_transaction_id = ''
     OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[a-f0-9]{64}$' THEN
    RETURN 'DENY_INVALID';
  END IF;
  SELECT * INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN_ORDER'; END IF;
  IF o.provider IS DISTINCT FROM p_provider OR NOT EXISTS (
      SELECT 1 FROM provider_captures
       WHERE provider = p_provider AND transaction_id = p_provider_transaction_id
         AND order_id = p_order_id
  ) THEN RETURN 'DENY_CAPTURE_MISMATCH'; END IF;

  SELECT * INTO v_existing FROM verified_payment_events
    WHERE provider = p_provider AND provider_event_id = p_provider_event_id;
  IF FOUND THEN
    IF v_existing.order_id = p_order_id AND v_existing.event_kind = 'REFUND'
       AND o.state = 'REFUNDED' THEN
      PERFORM record_payment_delivery(p_provider, p_provider_transaction_id, 'REFUND', p_payload_sha256);
      RETURN 'DUPLICATE_EVENT';
    END IF;
    RETURN 'DENY_EVENT_REUSED';
  END IF;
  IF o.state = 'REFUNDED' AND EXISTS (
       SELECT 1 FROM verified_payment_events
        WHERE provider = p_provider AND order_id = p_order_id AND event_kind = 'REFUND') THEN
    PERFORM record_payment_delivery(p_provider, p_provider_transaction_id, 'REFUND', p_payload_sha256);
    RETURN 'DUPLICATE_REFUND';
  END IF;
  IF o.state <> 'PAID' THEN RETURN 'DENY_NOT_PAID'; END IF;

  INSERT INTO verified_payment_events(provider, provider_event_id, order_id,
                                      verified_at, payload_sha256, event_kind)
    VALUES (p_provider, p_provider_event_id, p_order_id,
            clock_timestamp(), p_payload_sha256, 'REFUND');
  PERFORM record_payment_delivery(p_provider, p_provider_transaction_id, 'REFUND', p_payload_sha256);
  UPDATE orders SET state = 'REFUNDED' WHERE id = p_order_id;
  UPDATE entitlements
     SET state = 'REFUNDED', revision = revision + 1
   WHERE source_order_id = p_order_id AND state <> 'REFUNDED';
  INSERT INTO reconcile_outbox(entitlement_id, desired_revision)
    SELECT id, revision FROM entitlements WHERE source_order_id = p_order_id
    ON CONFLICT (entitlement_id, desired_revision) DO NOTHING;
  RETURN 'APPLIED';
END;
$$;

-- Maintenance job (not deployed). Never declares expiry to be enforced by VPN
-- Node; only updates the desired business state and enqueues reconciliation.
CREATE FUNCTION expire_due_entitlements() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_count integer;
BEGIN
  WITH expired AS (
    UPDATE entitlements SET state = 'EXPIRED', revision = revision + 1
     WHERE expires_at <= clock_timestamp()
       AND state IN ('ACTIVE', 'PAID_PENDING_PROVISIONING',
                     'PROVISIONING_FAILED', 'SUSPENDED')
     RETURNING id, revision
  ), events AS (
    INSERT INTO reconcile_outbox(entitlement_id, desired_revision)
      SELECT id, revision FROM expired
      ON CONFLICT (entitlement_id, desired_revision) DO NOTHING
    RETURNING id
  )
  SELECT count(*)::integer INTO v_count FROM expired;
  RETURN v_count;
END;
$$;

-- Monotonic fencing token for the provisioning worker. A real worker must ALSO
-- hold an exclusive operation lock across remote call and post-call inspection.
CREATE FUNCTION claim_provisioning_fence(p_entitlement_id uuid, p_adapter text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_token bigint;
BEGIN
  IF p_adapter NOT IN ('vpn', 'smart_dns') OR NOT EXISTS (
    SELECT 1 FROM entitlements
     WHERE id = p_entitlement_id AND product = p_adapter
  ) THEN RAISE EXCEPTION 'Invalid adapter for entitlement'; END IF;
  INSERT INTO provisioning_state(entitlement_id, adapter, fencing_token)
    VALUES(p_entitlement_id, p_adapter, 1)
    ON CONFLICT (entitlement_id, adapter)
    DO UPDATE SET fencing_token = provisioning_state.fencing_token + 1
    RETURNING fencing_token INTO v_token;
  RETURN v_token;
END;
$$;

-- Acknowledgement is only allowed after adapter-side observation. Serializing
-- on the entitlement row also prevents a concurrent REFUND between CAS and
-- changing PAID_PENDING_PROVISIONING -> ACTIVE.
CREATE FUNCTION acknowledge_provisioning(
  p_entitlement_id uuid, p_adapter text, p_revision bigint,
  p_fencing_token bigint, p_observed_enabled boolean
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_entitlement entitlements%ROWTYPE;
  v_desired_enabled boolean;
  v_rows int;
BEGIN
  SELECT * INTO v_entitlement FROM entitlements
    WHERE id = p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_entitlement.product IS DISTINCT FROM p_adapter
     OR v_entitlement.revision IS DISTINCT FROM p_revision THEN
    RETURN false;
  END IF;
  v_desired_enabled :=
    v_entitlement.state IN ('PAID_PENDING_PROVISIONING', 'PROVISIONING_FAILED', 'ACTIVE')
    AND COALESCE(v_entitlement.expires_at > clock_timestamp(), false)
    AND (v_entitlement.quota_limit_bytes IS NULL
      OR v_entitlement.quota_used_bytes < v_entitlement.quota_limit_bytes);
  IF p_observed_enabled IS DISTINCT FROM v_desired_enabled THEN RETURN false; END IF;
  UPDATE provisioning_state
     SET applied_revision = p_revision, last_observed_at = clock_timestamp()
    WHERE entitlement_id = p_entitlement_id AND adapter = p_adapter
      AND fencing_token = p_fencing_token;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RETURN false; END IF;
  IF v_desired_enabled THEN
    UPDATE entitlements SET state = 'ACTIVE'
     WHERE id = p_entitlement_id
       AND state IN ('PAID_PENDING_PROVISIONING', 'PROVISIONING_FAILED');
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION record_payment_delivery(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_verified_payment(uuid,text,text,text,text,bigint,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_verified_refund(uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION expire_due_entitlements() FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_provisioning_fence(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION acknowledge_provisioning(uuid,text,bigint,bigint,boolean) FROM PUBLIC;
COMMIT;
