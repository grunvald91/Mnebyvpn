BEGIN;
DO $$
DECLARE
  matched int;
  a uuid := '13300000-0000-4000-8000-000000000001';
  o uuid := '13300000-0000-4000-8000-000000000002';
  res text;
  ent_cnt int;
BEGIN
  SELECT count(*)::int INTO matched
  FROM billing_plans
  WHERE id IN (
    'vpn_15d_1device','vpn_30d_1device','vpn_60d_1device','vpn_90d_1device',
    'smart_dns_15d_rub','smart_dns_30d_rub','smart_dns_60d_rub','smart_dns_90d_rub',
    'bundle_15d_3device','bundle_30d_3device','bundle_60d_3device','bundle_90d_3device'
  )
    AND enabled = true
    AND rub_minor > 0
    AND stars > 0;
  IF matched <> 12 THEN
    RAISE EXCEPTION 'All 12 catalog plans must have integer Stars and RUB prices, found %', matched;
  END IF;

  INSERT INTO accounts(id, telegram_user_id) VALUES(a, '771330001');
  INSERT INTO orders(id, account_id, product, provider, amount_minor, currency)
    VALUES(o, a, 'bundle', 'telegram_stars', 280, 'XTR');
  INSERT INTO order_terms(order_id, plan_id, plan_title, duration_seconds, dns_quota_bytes, dns_quota_queries_per_30d, expires_at, device_limit)
    VALUES(o, 'bundle_30d_3device', 'Экосистема «3 в 1» · 30 дней · до 3 устройств',
      30*86400, NULL, 1000000, clock_timestamp() + interval '1 hour', 3);

  SELECT settle_verified_payment(
    o, 'telegram_stars', 'tg:1330001', 'charge-tg-1330001', repeat('c', 64),
    280, 'XTR', 30*86400, NULL
  ) INTO res;
  IF res <> 'APPLIED' THEN
    RAISE EXCEPTION 'Expected APPLIED for bundle Stars settlement, got %', res;
  END IF;

  SELECT count(*)::int INTO ent_cnt
  FROM entitlements
  WHERE source_order_id = o
    AND product IN ('vpn', 'smart_dns');
  IF ent_cnt <> 2 THEN
    RAISE EXCEPTION 'Expected both vpn and smart_dns entitlements for bundle Stars order, got %', ent_cnt;
  END IF;
END $$;
ROLLBACK;
