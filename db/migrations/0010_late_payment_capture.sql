-- Phase 10: accept verified provider captures after timeout cancellation.
-- A signed/verified charge is proof; an internal timeout is NOT a refund.
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

REVOKE ALL ON FUNCTION settle_verified_payment(uuid,text,text,text,text,bigint,text,bigint,bigint) FROM PUBLIC;
COMMIT;
