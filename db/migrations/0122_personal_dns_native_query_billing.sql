-- Native commercial premium DNS-question quota (not byte metering).
-- New 200-Star offer stays enabled=false until a real external Android TLS/853
-- check succeeds. Existing VPN, byte DNS, and bundle plans are unchanged.
BEGIN;
ALTER TABLE billing_plans ADD COLUMN dns_quota_queries_per_30d bigint
  CHECK (dns_quota_queries_per_30d BETWEEN 1 AND 100000000);
ALTER TABLE order_terms ADD COLUMN dns_quota_queries_per_30d bigint
  CHECK (dns_quota_queries_per_30d BETWEEN 1 AND 100000000);
ALTER TABLE pricing_drafts ADD COLUMN dns_quota_queries_per_30d bigint
  CHECK (dns_quota_queries_per_30d BETWEEN 1 AND 100000000);
ALTER TABLE entitlements ADD COLUMN dns_query_quota_per_30d bigint
  CHECK (dns_query_quota_per_30d BETWEEN 1 AND 100000000);
ALTER TABLE entitlement_credits ADD COLUMN quota_queries_per_30d bigint
  CHECK (quota_queries_per_30d BETWEEN 1 AND 100000000);
DO $$
DECLARE n text; ct integer;
BEGIN
  SELECT count(*),min(c.conname) INTO ct,n FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    WHERE t.relname='billing_plans' AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%product%'
      AND pg_get_constraintdef(c.oid) ILIKE '%dns_quota_bytes%';
  IF ct<>1 THEN RAISE EXCEPTION 'Expected precisely one legacy billing plan quota mode constraint, got %',ct; END IF;
  EXECUTE format('ALTER TABLE billing_plans DROP CONSTRAINT %I',n);
  SELECT count(*),min(c.conname) INTO ct,n FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    WHERE t.relname='entitlements' AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%product%'
      AND pg_get_constraintdef(c.oid) ILIKE '%quota_limit_bytes%';
  IF ct<>1 THEN RAISE EXCEPTION 'Expected precisely one legacy entitlement quota mode constraint, got %',ct; END IF;
  EXECUTE format('ALTER TABLE entitlements DROP CONSTRAINT %I',n);
END $$;
ALTER TABLE billing_plans ADD CONSTRAINT billing_plans_dns_meter_mode_ck
  CHECK (
    (product='vpn' AND dns_quota_bytes IS NULL AND dns_quota_queries_per_30d IS NULL)
    OR (product='bundle' AND dns_quota_bytes IS NOT NULL AND dns_quota_queries_per_30d IS NULL)
    OR (product='smart_dns' AND (
      (dns_quota_bytes IS NOT NULL AND dns_quota_queries_per_30d IS NULL)
      OR (dns_quota_bytes IS NULL AND dns_quota_queries_per_30d IS NOT NULL)
    ))
  );
ALTER TABLE entitlements ADD CONSTRAINT entitlements_dns_meter_mode_ck
  CHECK (
    (product='vpn' AND dns_query_quota_per_30d IS NULL)
    OR (product='smart_dns' AND (
      (quota_limit_bytes IS NOT NULL AND dns_query_quota_per_30d IS NULL)
      OR (quota_limit_bytes IS NULL AND dns_query_quota_per_30d IS NOT NULL)
    ))
  );
UPDATE pricing_drafts SET dns_quota_queries_per_30d=1000000
  WHERE product='smart_dns' AND duration_seconds=2592000
    AND stars=200 AND rub_minor=20000 AND dns_quota_bytes IS NULL;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM billing_plans WHERE id='personal_dns_30d_stars'
    AND (product<>'smart_dns' OR enabled)) THEN
    RAISE EXCEPTION 'Refusing to override an active or unrelated offer';
  END IF;
END $$;
INSERT INTO billing_plans(id,product,title,duration_seconds,
  dns_quota_bytes,dns_quota_queries_per_30d,rub_minor,stars,enabled,device_limit)
VALUES ('personal_dns_30d_stars','smart_dns',
  'Smart DNS · 30 дней · персональный адрес',2592000,
  NULL,1000000,20000,200,false,1)
ON CONFLICT(id) DO UPDATE SET
  title=EXCLUDED.title,duration_seconds=EXCLUDED.duration_seconds,
  dns_quota_bytes=NULL,dns_quota_queries_per_30d=1000000,
  stars=200,rub_minor=20000,enabled=false;

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
  v_personal_queries bigint;
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
  SELECT dns_quota_queries_per_30d INTO v_personal_queries
    FROM order_terms WHERE order_id=p_order_id;
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
  -- Legacy DNS/bundle uses bytes. New PERSONAL DNS uses only settled
  -- premium DNS questions from its immutable order_terms snapshot.
  IF o.product IN ('smart_dns', 'bundle') AND
     (p_dns_quota_bytes IS NULL OR p_dns_quota_bytes <= 0)
     AND NOT (o.product='smart_dns' AND p_dns_quota_bytes IS NULL
       AND v_personal_queries BETWEEN 1 AND 100000000) THEN
    RETURN 'DENY_QUOTA_INVALID';
  END IF;
  IF p_dns_quota_bytes IS NOT NULL AND v_personal_queries IS NOT NULL THEN
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
      starts_at,ends_at,duration_seconds,quota_bytes,quota_queries_per_30d)
      VALUES(v_renewal.entitlement_id,p_order_id,v_credit_sequence,
        v_credit_start,v_credit_start+make_interval(secs=>p_duration_seconds::double precision),
        p_duration_seconds,p_dns_quota_bytes,v_personal_queries);
    UPDATE entitlements SET
      starts_at=CASE WHEN v_target.state IN ('REFUNDED','CANCELLED')
        THEN v_start ELSE starts_at END,
      expires_at=CASE WHEN v_target.state IN ('REFUNDED','CANCELLED')
        THEN v_start + make_interval(secs=>p_duration_seconds::double precision)
        ELSE GREATEST(v_target.expires_at,v_start)
          + make_interval(secs=>p_duration_seconds::double precision) END,
      quota_limit_bytes=CASE WHEN o.product='smart_dns'
        AND v_personal_queries IS NULL
        THEN GREATEST(v_target.quota_used_bytes,
          COALESCE((SELECT sum(c.quota_bytes) FROM entitlement_credits c
            WHERE c.entitlement_id=v_renewal.entitlement_id
              AND c.refunded_at IS NULL AND c.order_id<>p_order_id),0))
          + p_dns_quota_bytes ELSE NULL END,
      dns_query_quota_per_30d=v_personal_queries,
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
      state, revision, starts_at, expires_at, quota_limit_bytes,dns_query_quota_per_30d)
    VALUES(v_id, o.account_id, p_order_id, v_product,
      'PAID_PENDING_PROVISIONING', 1,
      CASE WHEN v_product='vpn' AND (SELECT enabled FROM vpn_release_flags
        WHERE feature='paid_vpn_clock_on_node') THEN NULL ELSE v_start END,
      CASE WHEN v_product='vpn' AND (SELECT enabled FROM vpn_release_flags
        WHERE feature='paid_vpn_clock_on_node') THEN NULL
        ELSE v_start + make_interval(secs => p_duration_seconds::double precision) END,
      CASE WHEN v_product = 'smart_dns' THEN p_dns_quota_bytes ELSE NULL END,
      CASE WHEN v_product = 'smart_dns' THEN v_personal_queries ELSE NULL END);
    INSERT INTO entitlement_credits(entitlement_id,order_id,credit_sequence,
      starts_at,ends_at,duration_seconds,quota_bytes,quota_queries_per_30d)
      VALUES(v_id,p_order_id,0,v_start,
        v_start+make_interval(secs=>p_duration_seconds::double precision),
        p_duration_seconds,CASE WHEN v_product='smart_dns' THEN p_dns_quota_bytes ELSE NULL END,
        CASE WHEN v_product='smart_dns' THEN v_personal_queries ELSE NULL END);
    INSERT INTO reconcile_outbox(entitlement_id, desired_revision)
      VALUES(v_id, 1);
  END LOOP;
  RETURN 'APPLIED';
END;
$$;

CREATE OR REPLACE FUNCTION apply_verified_refund(
  p_order_id uuid, p_provider text, p_provider_event_id text,
  p_provider_transaction_id text, p_payload_sha256 text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  o orders%ROWTYPE;
  v_existing verified_payment_events%ROWTYPE;
  v_credit entitlement_credits%ROWTYPE;
  v_entitlement entitlements%ROWTYPE;
  v_refund_at timestamptz := clock_timestamp();
  v_shift interval;
  v_final timestamptz;
  v_total_quota numeric;
  v_limit bigint;
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
  -- An old paid order without a ledger must never be silently refunded in
  -- business state while leaving untracked network access. Operator review.
  IF NOT EXISTS (SELECT 1 FROM entitlement_credits
    WHERE order_id=p_order_id AND refunded_at IS NULL) THEN
    RETURN 'DENY_CREDIT_LEDGER';
  END IF;
  UPDATE orders SET state='REFUNDED' WHERE id=p_order_id;
  FOR v_credit IN
    SELECT * FROM entitlement_credits WHERE order_id=p_order_id
      AND refunded_at IS NULL ORDER BY entitlement_id
  LOOP
    -- Lock entitlement BEFORE credit. Debit and renewal use this lock order.
    SELECT * INTO v_entitlement FROM entitlements
      WHERE id=v_credit.entitlement_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Credit entitlement missing'; END IF;
    SELECT * INTO v_credit FROM entitlement_credits
      WHERE entitlement_id=v_credit.entitlement_id
        AND order_id=p_order_id FOR UPDATE;
    -- Consume FIFO: paid time already used is not removed retrospectively.
    -- Only the portion of this purchase that has not begun/elapsed is removed.
    -- Later paid credits shift earlier without erasing their purchased duration.
    v_shift := GREATEST(interval '0 seconds',
       v_credit.ends_at - GREATEST(v_credit.starts_at,v_refund_at));
    UPDATE entitlement_credits SET
      starts_at=starts_at-v_shift,ends_at=ends_at-v_shift
      WHERE entitlement_id=v_credit.entitlement_id
        AND credit_sequence>v_credit.credit_sequence AND refunded_at IS NULL;
    UPDATE entitlement_credits SET refunded_at=v_refund_at
      WHERE entitlement_id=v_credit.entitlement_id AND order_id=p_order_id;
    SELECT max(ends_at),COALESCE(sum(
        CASE WHEN quota_bytes IS NOT NULL
          THEN quota_bytes-consumed_bytes ELSE 0 END),0)
      INTO v_final,v_total_quota FROM entitlement_credits
      WHERE entitlement_id=v_credit.entitlement_id AND refunded_at IS NULL;
    v_limit := CASE WHEN v_entitlement.product='smart_dns'
      AND v_entitlement.dns_query_quota_per_30d IS NULL
      THEN (v_entitlement.quota_used_bytes+v_total_quota)::bigint
      ELSE NULL END;
    UPDATE entitlements SET
      expires_at=COALESCE(v_final,expires_at),
      quota_limit_bytes=v_limit,
      quota_state=CASE WHEN v_entitlement.dns_query_quota_per_30d IS NOT NULL
        THEN 'AVAILABLE' WHEN product='smart_dns' AND
        v_limit<=quota_used_bytes THEN 'EXHAUSTED' ELSE 'AVAILABLE' END,
      state=CASE WHEN v_final IS NULL THEN 'REFUNDED'
        WHEN v_final<=v_refund_at THEN 'EXPIRED'
        WHEN state='SUSPENDED' THEN 'SUSPENDED'
        ELSE 'PAID_PENDING_PROVISIONING' END,
      revision=revision+1
      WHERE id=v_credit.entitlement_id;
    INSERT INTO reconcile_outbox(entitlement_id,desired_revision)
      SELECT id,revision FROM entitlements WHERE id=v_credit.entitlement_id
      ON CONFLICT(entitlement_id,desired_revision) DO NOTHING;
  END LOOP;
  RETURN 'APPLIED';
END;
$$;

REVOKE ALL ON FUNCTION apply_verified_refund(uuid,text,text,text,text) FROM PUBLIC;


REVOKE ALL ON FUNCTION settle_verified_payment(uuid,text,text,text,text,bigint,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_verified_refund(uuid,text,text,text,text) FROM PUBLIC;
COMMIT;
