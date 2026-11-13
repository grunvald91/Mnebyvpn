-- Production billing SQL contract, isolated PostgreSQL transaction.
-- Fixed 200 XTR paid offer uses 1M premium DNS queries, never bytes.
BEGIN;
DO $$
DECLARE
  a uuid:='12200000-0000-4000-8000-000000000001';
  o uuid:='12200000-0000-4000-8000-000000000002';
  e uuid;
  v text;
  fence bigint;
  lbl text:='q2dnszz777aa';
BEGIN
  IF NOT EXISTS(SELECT 1 FROM billing_plans
    WHERE id='personal_dns_30d_stars' AND enabled=false AND
      product='smart_dns' AND stars=200 AND dns_quota_bytes IS NULL
      AND dns_quota_queries_per_30d=1000000 AND duration_seconds=2592000
  ) THEN RAISE EXCEPTION 'Native DNS 200 XTR catalog mismatch'; END IF;
  INSERT INTO accounts(id,telegram_user_id) VALUES(a,745636272);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
    VALUES(o,a,'smart_dns','telegram_stars',200,'XTR');
  INSERT INTO order_terms(order_id,plan_id,plan_title,duration_seconds,
    dns_quota_bytes,dns_quota_queries_per_30d,expires_at)
    VALUES(o,'personal_dns_30d_stars','Smart DNS · 30 дней · персональный адрес',
      2592000,NULL,1000000,clock_timestamp()+interval '1 hour');
  SELECT settle_verified_payment(o,'telegram_stars',
    'personal-stars-paid-122','personal-stars-charge-122',
    repeat('a',64),200,'XTR',2592000,NULL) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'Stars paid settlement failed: %',v; END IF;
  SELECT id INTO e FROM entitlements WHERE source_order_id=o AND product='smart_dns';
  IF NOT FOUND THEN RAISE EXCEPTION 'No personal DNS entitlement after trusted paid capture'; END IF;
  IF NOT EXISTS(SELECT 1 FROM entitlements
    WHERE id=e AND state='PAID_PENDING_PROVISIONING'
      AND quota_limit_bytes IS NULL AND dns_query_quota_per_30d=1000000)
  THEN RAISE EXCEPTION 'Native query plan contaminated by legacy byte quota'; END IF;
  IF NOT EXISTS(SELECT 1 FROM entitlement_credits
    WHERE order_id=o AND quota_bytes IS NULL AND quota_queries_per_30d=1000000)
  THEN RAISE EXCEPTION 'Native query credit missing'; END IF;
  SELECT settle_verified_payment(o,'telegram_stars',
    'personal-stars-paid-122','personal-stars-charge-122',
    repeat('a',64),200,'XTR',2592000,NULL) INTO v;
  IF v<>'DUPLICATE_EVENT' THEN RAISE EXCEPTION 'Stars redelivery double-credited: %',v; END IF;
  SELECT claim_provisioning_fence(e,'smart_dns') INTO fence;
  IF NOT acknowledge_provisioning(e,'smart_dns',1,fence,true)
  THEN RAISE EXCEPTION 'Test adapter could not ACK valid paid DNS state'; END IF;
  IF NOT EXISTS(SELECT 1 FROM entitlements WHERE id=e AND state='ACTIVE')
  THEN RAISE EXCEPTION 'Activation not durable'; END IF;
  SELECT issue_personal_dns_credential(e,lbl,encode(sha256(convert_to(lbl,'UTF8')),'hex'),1000000)
    INTO v;
  IF v<>'ISSUED' THEN RAISE EXCEPTION 'Cannot issue personal hostname: %',v; END IF;
  IF NOT EXISTS(SELECT 1 FROM personal_dns_query_status(e)
    WHERE allowed_queries=1000000 AND used_queries=0)
  THEN RAISE EXCEPTION 'Query meter wrong at activation'; END IF;
  SELECT apply_verified_refund(o,'telegram_stars','personal-stars-refund-122',
    'personal-stars-charge-122',repeat('b',64)) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'Stars refund failed: %',v; END IF;
  IF NOT EXISTS(SELECT 1 FROM entitlements
    WHERE id=e AND state='REFUNDED' AND quota_limit_bytes IS NULL)
  THEN RAISE EXCEPTION 'Refund left mixed byte/quota or active grant'; END IF;
  IF recognize_personal_dns_credential(lbl)
  THEN RAISE EXCEPTION 'Refund still resolves personal DNS bearer'; END IF;
  SELECT reserve_personal_dns_query(lbl,gen_random_uuid()) INTO v;
  IF v<>'DENY_INACTIVE' THEN RAISE EXCEPTION 'Refund retained premium DNS: %',v; END IF;
END $$;
ROLLBACK;
