-- Phase 15: on-ledger FIFO charging for each Smart DNS paid credit.
-- Refunding any purchase preserves quota purchased in later orders, even when
-- older credits were partly/fully consumed. No real ingress is implied.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM entitlements WHERE quota_used_bytes>0) THEN
    RAISE EXCEPTION 'Existing nonzero usage requires a verified per-credit backfill';
  END IF;
END $$;
ALTER TABLE entitlement_credits
  ADD COLUMN consumed_bytes bigint NOT NULL DEFAULT 0 CHECK(consumed_bytes>=0),
  ADD CONSTRAINT credit_consumed_limit CHECK(
    (quota_bytes IS NULL AND consumed_bytes=0) OR
    (quota_bytes IS NOT NULL AND consumed_bytes<=quota_bytes)
  );

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
    SELECT COALESCE(max(credit_sequence),-1)+1 INTO v_credit_sequence
      FROM entitlement_credits WHERE entitlement_id=v_renewal.entitlement_id;
    IF NOT EXISTS (SELECT 1 FROM entitlement_credits
      WHERE entitlement_id=v_renewal.entitlement_id) THEN
      RETURN 'DENY_CREDIT_LEDGER';
    END IF;
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
      -- Global meter never forgets bytes already spent, including refunded
      -- credits. Available bytes come exclusively from still-paid credits.
      quota_limit_bytes=CASE WHEN o.product='smart_dns'
        THEN v_target.quota_used_bytes +
          COALESCE((SELECT sum(c.quota_bytes-c.consumed_bytes)
            FROM entitlement_credits c WHERE
            c.entitlement_id=v_renewal.entitlement_id AND
            c.refunded_at IS NULL),0)::bigint ELSE NULL END,
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
      'PAID_PENDING_PROVISIONING', 1, v_start,
      v_start + make_interval(secs => p_duration_seconds::double precision),
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

REVOKE ALL ON FUNCTION settle_verified_payment(uuid,text,text,text,text,bigint,text,bigint,bigint) FROM PUBLIC;

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
      THEN (v_entitlement.quota_used_bytes+v_total_quota)::bigint
      ELSE NULL END;
    UPDATE entitlements SET
      expires_at=COALESCE(v_final,expires_at),
      quota_limit_bytes=v_limit,
      quota_state=CASE WHEN product='smart_dns' AND
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

CREATE OR REPLACE FUNCTION debit_smart_dns_quota(
  p_entitlement_id uuid, p_usage_event_id text, p_bytes bigint
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  current_entitlement entitlements%ROWTYPE;
  is_exhausted boolean;
  v_credit entitlement_credits%ROWTYPE;
  v_remaining bigint;
  v_take bigint;
  v_available numeric;
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
  SELECT COALESCE(sum(quota_bytes-consumed_bytes),0) INTO v_available
    FROM entitlement_credits WHERE entitlement_id=p_entitlement_id
      AND refunded_at IS NULL AND quota_bytes IS NOT NULL;
  IF v_available<p_bytes THEN RETURN 'DENY_QUOTA'; END IF;
  v_remaining:=p_bytes;
  FOR v_credit IN
    SELECT * FROM entitlement_credits WHERE entitlement_id=p_entitlement_id
      AND refunded_at IS NULL AND quota_bytes IS NOT NULL
      AND consumed_bytes<quota_bytes ORDER BY credit_sequence FOR UPDATE
  LOOP
    v_take:=LEAST(v_remaining,v_credit.quota_bytes-v_credit.consumed_bytes);
    UPDATE entitlement_credits SET consumed_bytes=consumed_bytes+v_take
      WHERE entitlement_id=p_entitlement_id AND order_id=v_credit.order_id;
    v_remaining:=v_remaining-v_take;
    EXIT WHEN v_remaining=0;
  END LOOP;
  IF v_remaining<>0 THEN
    RAISE EXCEPTION 'Quota credit ledger mismatch';
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
REVOKE ALL ON FUNCTION debit_smart_dns_quota(uuid,text,bigint) FROM PUBLIC;
COMMIT;
