-- Defer NEW paid VPN subscription time until a node-observed activation.
-- All renewals, existing ACTIVE access and DNS behavior retain prior semantics.
-- The provisional node expiry is never a free permanent credential.
BEGIN;
CREATE OR REPLACE FUNCTION settle_verified_payment(
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
  v_renewal order_renewals%ROWTYPE;
  v_target entitlements%ROWTYPE;
  v_credit_start timestamptz;
  v_credit_sequence integer;
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

  -- A real provider capture may be delivered AFTER checkout cleanup changed
  -- PENDING to CANCELLED. Never keep money without granting or refunding.
  -- This branch is reachable only after trusted provider verification.
  IF o.state NOT IN ('PENDING','CANCELLED') THEN
    RETURN 'DENY_ORDER_ALREADY_SETTLED';
  END IF;
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

  -- A verified capture credits the SAME entitlement: no duplicate credential.
  SELECT * INTO v_renewal FROM order_renewals WHERE order_id=p_order_id FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO v_target FROM entitlements WHERE id=v_renewal.entitlement_id FOR UPDATE;
    IF NOT FOUND OR v_target.account_id<>o.account_id
      OR v_target.product<>o.product OR o.product='bundle' THEN
      RETURN 'DENY_MISMATCH';
    END IF;
    -- A refunded original order can have a renewal checkout already pending.
    -- Only that previously authorized capture can restore the same credential.
    -- The original paid period stays excluded from the credit ledger.
    v_credit_start := CASE WHEN v_target.state IN ('REFUNDED','CANCELLED')
      THEN v_start ELSE GREATEST(v_target.expires_at,v_start) END;
    IF NOT EXISTS (SELECT 1 FROM entitlement_credits
      WHERE entitlement_id=v_renewal.entitlement_id) THEN
      -- Trials have no paid credits. Preserve their independently activated
      -- period as a zero-price baseline before appending the first paid credit.
      -- Refunds can then remove only the purchased extension, not the free day.
      INSERT INTO entitlement_credits(entitlement_id,order_id,credit_sequence,
        starts_at,ends_at,duration_seconds,quota_bytes)
      SELECT v_target.id,t.order_id,0,t.activated_at,t.access_expires_at,86400,
        CASE WHEN v_target.product='smart_dns' THEN v_target.quota_limit_bytes ELSE NULL END
      FROM trial_grants t JOIN orders trial ON trial.id=t.order_id
      WHERE t.order_id=v_target.source_order_id AND t.account_id=o.account_id
        AND trial.provider='internal_trial' AND trial.state='TRIAL'
        AND t.activated_at IS NOT NULL AND t.access_expires_at IS NOT NULL
        AND v_target.starts_at=t.activated_at AND v_target.expires_at=t.access_expires_at;
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN RETURN 'DENY_CREDIT_LEDGER'; END IF;
    END IF;
    SELECT COALESCE(max(credit_sequence),-1)+1 INTO v_credit_sequence
      FROM entitlement_credits WHERE entitlement_id=v_renewal.entitlement_id;
    INSERT INTO entitlement_credits(entitlement_id,order_id,credit_sequence,
      starts_at,ends_at,duration_seconds,quota_bytes)
      VALUES(v_renewal.entitlement_id,p_order_id,v_credit_sequence,
        v_credit_start,v_credit_start+make_interval(secs=>p_duration_seconds::double precision),
        p_duration_seconds,p_dns_quota_bytes);
    UPDATE entitlements SET
      starts_at=CASE WHEN v_target.state IN ('REFUNDED','CANCELLED')
        THEN v_start ELSE starts_at END,
      expires_at=CASE WHEN v_target.state IN ('REFUNDED','CANCELLED')
        THEN v_start + make_interval(secs=>p_duration_seconds::double precision)
        ELSE GREATEST(v_target.expires_at,v_start)
          + make_interval(secs=>p_duration_seconds::double precision) END,
      quota_limit_bytes=CASE WHEN o.product='smart_dns'
        THEN GREATEST(v_target.quota_used_bytes,
          COALESCE((SELECT sum(c.quota_bytes) FROM entitlement_credits c
            WHERE c.entitlement_id=v_renewal.entitlement_id
              AND c.refunded_at IS NULL AND c.order_id<>p_order_id),0))
          + p_dns_quota_bytes ELSE NULL END,
      quota_used_bytes=CASE WHEN v_target.state IN ('REFUNDED','CANCELLED')
        THEN 0 ELSE quota_used_bytes END,
      quota_state='AVAILABLE',
      state='PAID_PENDING_PROVISIONING',
      revision=revision+1
      WHERE id=v_renewal.entitlement_id;
    UPDATE order_renewals SET applied_at=v_start WHERE order_id=p_order_id;
    INSERT INTO reconcile_outbox(entitlement_id,desired_revision)
      SELECT id,revision FROM entitlements WHERE id=v_renewal.entitlement_id
      ON CONFLICT(entitlement_id,desired_revision) DO NOTHING;
    RETURN 'APPLIED';
  END IF;

  FOREACH v_product IN ARRAY CASE WHEN o.product = 'bundle'
      THEN ARRAY['vpn', 'smart_dns'] ELSE ARRAY[o.product] END
  LOOP
    v_id := gen_random_uuid();
    INSERT INTO entitlements(id, account_id, source_order_id, product,
      state, revision, starts_at, expires_at, quota_limit_bytes)
    VALUES(v_id, o.account_id, p_order_id, v_product,
      'PAID_PENDING_PROVISIONING', 1,
      CASE WHEN v_product='vpn' THEN NULL ELSE v_start END,
      CASE WHEN v_product='vpn' THEN NULL
        ELSE v_start + make_interval(secs => p_duration_seconds::double precision) END,
      CASE WHEN v_product = 'smart_dns' THEN p_dns_quota_bytes ELSE NULL END);
    INSERT INTO entitlement_credits(entitlement_id,order_id,credit_sequence,
      starts_at,ends_at,duration_seconds,quota_bytes)
      VALUES(v_id,p_order_id,0,v_start,
        v_start+make_interval(secs=>p_duration_seconds::double precision),
        p_duration_seconds,CASE WHEN v_product='smart_dns' THEN p_dns_quota_bytes ELSE NULL END);
    INSERT INTO reconcile_outbox(entitlement_id, desired_revision)
      VALUES(v_id, 1);
  END LOOP;
  RETURN 'APPLIED';
END;
$$;


CREATE OR REPLACE FUNCTION acknowledge_provisioning(
  p_entitlement_id uuid,p_adapter text,p_revision bigint,
  p_fencing_token bigint,p_observed_enabled boolean
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_ent entitlements%ROWTYPE;
  v_trial trial_grants%ROWTYPE;
  v_pending boolean;
  v_paid_duration bigint;
  v_paid_pending boolean;
  v_expected boolean;
  v_rows integer;
  v_at timestamptz;
BEGIN
  -- Acquire the order-wide trial lock FIRST. This serializes the two entitlements
  -- of a bundle before any entitlement row lock, avoiding cross-adapter deadlock.
  SELECT t.* INTO v_trial
    FROM trial_grants t
    JOIN entitlements e ON e.source_order_id=t.order_id
   WHERE e.id=p_entitlement_id
     FOR UPDATE OF t;
  SELECT * INTO v_ent FROM entitlements WHERE id=p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_ent.product IS DISTINCT FROM p_adapter
     OR v_ent.revision IS DISTINCT FROM p_revision THEN RETURN false; END IF;

  v_pending := v_trial.order_id IS NOT NULL
    AND v_trial.activated_at IS NULL
    AND v_ent.starts_at IS NULL AND v_ent.expires_at IS NULL;
  -- Only a signed, settled NEW paid VPN purchase may use provisional node expiry.
  -- Existing active paid renewals retain their already-running deadline.
  SELECT t.duration_seconds INTO v_paid_duration
    FROM orders o JOIN order_terms t ON t.order_id=o.id
    WHERE o.id=v_ent.source_order_id AND o.provider IN ('prodamus','telegram_stars')
      AND o.state='PAID' AND v_ent.product='vpn'
      AND v_ent.state IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED')
      AND v_ent.starts_at IS NULL AND v_ent.expires_at IS NULL
    LIMIT 1;
  v_paid_pending := v_paid_duration IS NOT NULL;
  v_expected := v_ent.state IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED','ACTIVE')
    AND v_ent.quota_state='AVAILABLE'
    AND (v_ent.quota_limit_bytes IS NULL
        OR v_ent.quota_used_bytes<v_ent.quota_limit_bytes)
    AND (v_pending OR v_paid_pending OR
      COALESCE(v_ent.expires_at>clock_timestamp(),false));

  IF p_observed_enabled IS DISTINCT FROM v_expected THEN RETURN false; END IF;
  UPDATE provisioning_state
     SET applied_revision=p_revision,last_observed_at=clock_timestamp()
   WHERE entitlement_id=p_entitlement_id AND adapter=p_adapter
     AND fencing_token=p_fencing_token;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RETURN false; END IF;

  IF v_pending AND v_expected THEN
    v_at:=clock_timestamp();
    UPDATE trial_grants
       SET activated_at=v_at,access_expires_at=v_at+interval '24 hours'
     WHERE order_id=v_trial.order_id AND activated_at IS NULL;
    -- Revision 2 is a deliberate second pass: the first node operation used
    -- a short provisional hard expiry, now it MUST apply the exact 24h deadline.
    WITH changed AS (
      UPDATE entitlements SET
        starts_at=v_at,
        expires_at=v_at+interval '24 hours',
        revision=revision+1,
        state=CASE WHEN id=p_entitlement_id THEN 'ACTIVE' ELSE state END
      WHERE source_order_id=v_trial.order_id
        AND state IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED','ACTIVE')
      RETURNING id,revision
    )
    INSERT INTO reconcile_outbox(entitlement_id,desired_revision)
      SELECT id,revision FROM changed
      ON CONFLICT(entitlement_id,desired_revision) DO NOTHING;
  ELSIF v_paid_pending AND v_expected THEN
    v_at := clock_timestamp();
    -- First node-ack proves a hard-enforced provisional VPN credential.
    -- Credit starts now, NOT at the prior payment time. A second node
    -- reconciliation must apply the full purchased deadline before ACTIVE.
    UPDATE entitlement_credits
       SET starts_at=v_at,
           ends_at=v_at+make_interval(secs=>v_paid_duration::double precision)
     WHERE entitlement_id=p_entitlement_id
       AND order_id=v_ent.source_order_id AND refunded_at IS NULL;
    IF NOT FOUND THEN RETURN false; END IF;
    UPDATE entitlements SET starts_at=v_at,
       expires_at=v_at+make_interval(secs=>v_paid_duration::double precision),
       revision=revision+1
     WHERE id=p_entitlement_id AND state IN
       ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED');
    INSERT INTO reconcile_outbox(entitlement_id,desired_revision)
      SELECT id,revision FROM entitlements WHERE id=p_entitlement_id
      ON CONFLICT(entitlement_id,desired_revision) DO NOTHING;
  ELSIF v_expected THEN
    UPDATE entitlements SET state='ACTIVE'
    WHERE id=p_entitlement_id
      AND state IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED');
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION settle_verified_payment(uuid,text,text,text,text,bigint,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION acknowledge_provisioning(uuid,text,bigint,bigint,boolean) FROM PUBLIC;
COMMIT;
