-- Contract tests for 0131: YooKassa checkout channel + 3-in-1 & Smart DNS RUB settlement.
BEGIN;
DO $$
DECLARE
  n integer;
  v_acc uuid := gen_random_uuid();
  v_ord uuid := gen_random_uuid();
  v_outcome text;
BEGIN
  SELECT count(*) INTO n FROM billing_plans
   WHERE enabled = true AND rub_minor IS NOT NULL
     AND id IN (
       'vpn_15d_1device','vpn_30d_1device','vpn_60d_1device','vpn_90d_1device',
       'smart_dns_15d_rub','smart_dns_30d_rub','smart_dns_60d_rub','smart_dns_90d_rub',
       'bundle_15d_3device','bundle_30d_3device','bundle_60d_3device','bundle_90d_3device'
     );
  IF n <> 12 THEN
    RAISE EXCEPTION 'Expected 12 active RUB plans in 3-in-1 catalog, got %', n;
  END IF;

  INSERT INTO accounts(id, email_address) VALUES (v_acc, 'contract-0131@example.test');
  INSERT INTO orders(id, account_id, product, provider, amount_minor, currency)
    VALUES (v_ord, v_acc, 'bundle', 'yookassa', 39900, 'RUB');
  INSERT INTO order_terms(order_id, plan_id, plan_title, duration_seconds,
    dns_quota_bytes, dns_quota_queries_per_30d, expires_at, device_limit)
    VALUES (v_ord, 'bundle_30d_3device', 'Экосистема «3 в 1» · 30 дней · до 3 устройств',
      30*86400, NULL, 1000000, clock_timestamp() + interval '1 hour', 3);
  INSERT INTO checkout_requests(channel, request_id, order_id)
    VALUES ('yookassa', 'req-0131-test', v_ord);
  INSERT INTO yookassa_payments(order_id, payment_id)
    VALUES (v_ord, '2f000000-000f-5000-8000-000000000001');

  SELECT settle_verified_payment(
    v_ord, 'yookassa', 'paid:2f000000-000f-5000-8000-000000000001',
    '2f000000-000f-5000-8000-000000000001', repeat('a', 64),
    39900, 'RUB', 30*86400, NULL
  ) INTO v_outcome;
  IF v_outcome <> 'APPLIED' THEN
    RAISE EXCEPTION 'Expected APPLIED for YooKassa bundle settlement, got %', v_outcome;
  END IF;

  SELECT count(*) INTO n FROM entitlements WHERE source_order_id = v_ord;
  IF n <> 2 THEN
    RAISE EXCEPTION 'Bundle must produce both vpn and smart_dns entitlements, got %', n;
  END IF;
  SELECT count(*) INTO n FROM entitlements
   WHERE source_order_id = v_ord AND product = 'smart_dns'
     AND dns_query_quota_per_30d = 1000000 AND quota_limit_bytes IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'Bundle smart_dns entitlement must carry 1M query quota';
  END IF;
END $$;
ROLLBACK;
