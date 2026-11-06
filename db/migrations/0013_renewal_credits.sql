-- Phase 13: stable per-account/product credential identity across paid renewals.
-- Each order retains its own credit ledger, including for refund reconciliation.
BEGIN;
CREATE TABLE account_product_slot (
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
 product text NOT NULL CHECK(product IN ('vpn','smart_dns')),
 entitlement_id uuid NOT NULL UNIQUE REFERENCES entitlements(id) ON DELETE RESTRICT,
 PRIMARY KEY(account_id,product)
);
CREATE TABLE order_entitlement_credits (
 order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 product text NOT NULL CHECK(product IN ('vpn','smart_dns')),
 entitlement_id uuid NOT NULL REFERENCES entitlements(id) ON DELETE RESTRICT,
 duration_seconds bigint NOT NULL CHECK(duration_seconds>0),
 dns_quota_bytes bigint CHECK(dns_quota_bytes>0),
 refunded boolean NOT NULL DEFAULT false,
 PRIMARY KEY(order_id,product)
);
CREATE INDEX order_entitlement_credits_ent_idx
 ON order_entitlement_credits(entitlement_id) WHERE refunded=false;

-- Existing paid orders retain historical entitlement IDs. Previously
-- duplicated profiles require explicit later migration/revocation policy.
INSERT INTO order_entitlement_credits(order_id,product,entitlement_id,
 duration_seconds,dns_quota_bytes,refunded)
 SELECT e.source_order_id,e.product,e.id,t.duration_seconds,
  CASE WHEN e.product='smart_dns' THEN t.dns_quota_bytes ELSE NULL END,
  (o.state='REFUNDED')
 FROM entitlements e JOIN orders o ON o.id=e.source_order_id
 JOIN order_terms t ON t.order_id=o.id
 WHERE o.provider IN ('telegram_stars','prodamus');
INSERT INTO account_product_slot(account_id,product,entitlement_id)
 SELECT DISTINCT ON(e.account_id,e.product) e.account_id,e.product,e.id
 FROM entitlements e JOIN orders o ON o.id=e.source_order_id
 WHERE o.provider IN ('telegram_stars','prodamus')
 ORDER BY e.account_id,e.product,
  CASE WHEN e.state IN ('ACTIVE','PAID_PENDING_PROVISIONING','PROVISIONING_FAILED') THEN 0 ELSE 1 END,
  e.expires_at DESC NULLS LAST,e.id;

REVOKE ALL ON account_product_slot FROM PUBLIC;
REVOKE ALL ON order_entitlement_credits FROM PUBLIC;
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
  v_current entitlements%ROWTYPE;
  v_revision bigint;
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

  -- Serialize all paid extensions of this account, even for different orders.
  PERFORM id FROM accounts WHERE id=o.account_id FOR UPDATE;
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

  FOREACH v_product IN ARRAY CASE WHEN o.product='bundle'
    THEN ARRAY['vpn','smart_dns'] ELSE ARRAY[o.product] END
  LOOP
    v_current:=NULL;
    SELECT e.* INTO v_current
      FROM account_product_slot s JOIN entitlements e ON e.id=s.entitlement_id
     WHERE s.account_id=o.account_id AND s.product=v_product FOR UPDATE OF e;
    IF v_current.id IS NOT NULL AND v_current.state NOT IN ('REFUNDED','CANCELLED') THEN
      UPDATE entitlements SET
        expires_at=GREATEST(v_start,COALESCE(expires_at,v_start))+
          make_interval(secs => p_duration_seconds::double precision),
        quota_limit_bytes=CASE WHEN v_product='smart_dns'
          THEN COALESCE(quota_limit_bytes,0)+p_dns_quota_bytes ELSE NULL END,
        quota_state='AVAILABLE',
        state=CASE WHEN state IN ('ACTIVE','PAID_PENDING_PROVISIONING')
          THEN state ELSE 'PAID_PENDING_PROVISIONING' END,
        revision=revision+1
        WHERE id=v_current.id RETURNING id,revision INTO v_id,v_revision;
    ELSE
      v_id:=gen_random_uuid();
      v_revision:=1;
      INSERT INTO entitlements(id,account_id,source_order_id,product,state,
        revision,starts_at,expires_at,quota_limit_bytes)
      VALUES(v_id,o.account_id,p_order_id,v_product,'PAID_PENDING_PROVISIONING',
        1,v_start,v_start+make_interval(secs=>p_duration_seconds::double precision),
        CASE WHEN v_product='smart_dns' THEN p_dns_quota_bytes ELSE NULL END);
      INSERT INTO account_product_slot(account_id,product,entitlement_id)
        VALUES(o.account_id,v_product,v_id)
      ON CONFLICT(account_id,product)
        DO UPDATE SET entitlement_id=EXCLUDED.entitlement_id;
    END IF;
    INSERT INTO order_entitlement_credits
      (order_id,product,entitlement_id,duration_seconds,dns_quota_bytes)
      VALUES(p_order_id,v_product,v_id,p_duration_seconds,
        CASE WHEN v_product='smart_dns' THEN p_dns_quota_bytes ELSE NULL END);
    INSERT INTO reconcile_outbox(entitlement_id,desired_revision)
      VALUES(v_id,v_revision) ON CONFLICT DO NOTHING;
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
  v_credit RECORD;
  v_ent entitlements%ROWTYPE;
  v_remaining integer;
  v_new_expires timestamptz;
  v_new_quota bigint;
  v_revision bigint;
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
  -- Refund only the credited duration/quota, not another paid extension.
  -- Lock the account to serialize with concurrent settlement/renewal.
  PERFORM id FROM accounts WHERE id=o.account_id FOR UPDATE;
  FOR v_credit IN SELECT * FROM order_entitlement_credits
    WHERE order_id=p_order_id FOR UPDATE
  LOOP
    SELECT * INTO v_ent FROM entitlements WHERE id=v_credit.entitlement_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing credited entitlement'; END IF;
    UPDATE order_entitlement_credits SET refunded=true
      WHERE order_id=p_order_id AND product=v_credit.product;
    SELECT count(*)::integer INTO v_remaining FROM order_entitlement_credits
      WHERE entitlement_id=v_ent.id AND refunded=false;
    v_new_expires:=GREATEST(v_ent.starts_at+interval '1 second',
      v_ent.expires_at-make_interval(secs=>v_credit.duration_seconds::double precision));
    v_new_quota:=CASE WHEN v_credit.product='smart_dns'
       THEN GREATEST(v_ent.quota_used_bytes,
          COALESCE(v_ent.quota_limit_bytes,0)-COALESCE(v_credit.dns_quota_bytes,0))
       ELSE NULL END;
    UPDATE entitlements SET
      expires_at=v_new_expires,
      quota_limit_bytes=v_new_quota,
      quota_state=CASE WHEN v_credit.product='smart_dns'
         AND v_new_quota<=quota_used_bytes THEN 'EXHAUSTED' ELSE quota_state END,
      state=CASE WHEN v_remaining=0 OR v_new_expires<=clock_timestamp()
        THEN 'REFUNDED' ELSE state END,
      revision=revision+1
      WHERE id=v_ent.id RETURNING revision INTO v_revision;
    INSERT INTO reconcile_outbox(entitlement_id,desired_revision)
      VALUES(v_ent.id,v_revision) ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN 'APPLIED';
END;
$$;

REVOKE ALL ON FUNCTION apply_verified_refund(uuid,text,text,text,text) FROM PUBLIC;
COMMIT;
