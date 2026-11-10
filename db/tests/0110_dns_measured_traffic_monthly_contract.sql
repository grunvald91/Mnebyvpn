-- Issue #84: disposable PostgreSQL tests for directional on-ledger bytes,
-- account isolation, exact idempotency and UTC month boundaries.
BEGIN;
DO $$
DECLARE
  owner_a uuid := 'c1100000-0000-4000-8000-000000000001';
  owner_b uuid := 'c1100000-0000-4000-8000-000000000002';
  order_a uuid := 'c1100000-0000-4000-8000-000000000003';
  order_b uuid := 'c1100000-0000-4000-8000-000000000004';
  ent_a uuid;
  ent_b uuid;
  result text;
  n bigint;
  report record;
BEGIN
  INSERT INTO accounts(id) VALUES(owner_a),(owner_b);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
  VALUES(order_a,owner_a,'smart_dns','mock',10000,'RUB'),
        (order_b,owner_b,'smart_dns','mock',10000,'RUB');
  SELECT settle_verified_payment(order_a,'mock','m110-a','m110-ca',repeat('a',64),
                                 10000,'RUB',3600,1024) INTO result;
  IF result <> 'APPLIED' THEN RAISE EXCEPTION 'paid A %',result; END IF;
  SELECT settle_verified_payment(order_b,'mock','m110-b','m110-cb',repeat('b',64),
                                 10000,'RUB',3600,2048) INTO result;
  IF result <> 'APPLIED' THEN RAISE EXCEPTION 'paid B %',result; END IF;
  SELECT id INTO ent_a FROM entitlements WHERE source_order_id=order_a;
  SELECT id INTO ent_b FROM entitlements WHERE source_order_id=order_b;
  UPDATE entitlements SET state='ACTIVE' WHERE id IN (ent_a,ent_b);

  SELECT record_smart_dns_measured_traffic(ent_a,'oct-A',120,280) INTO result;
  IF result <> 'ACCEPTED' THEN RAISE EXCEPTION 'oct A: %',result; END IF;
  SELECT record_smart_dns_measured_traffic(ent_a,'nov-A',240,384) INTO result;
  IF result <> 'ACCEPTED' THEN RAISE EXCEPTION 'nov A: %',result; END IF;
  SELECT record_smart_dns_measured_traffic(ent_a,'nov-A',240,384) INTO result;
  IF result <> 'DUPLICATE' THEN RAISE EXCEPTION 'retry not idempotent: %',result; END IF;
  SELECT record_smart_dns_measured_traffic(ent_a,'nov-A',200,424) INTO result;
  IF result <> 'DENY_EVENT_CONFLICT' THEN RAISE EXCEPTION 'conflicting retry: %',result; END IF;
  SELECT record_smart_dns_measured_traffic(ent_a,'nov-A',240,385) INTO result;
  IF result <> 'DENY_EVENT_CONFLICT' THEN RAISE EXCEPTION 'one byte changed: %',result; END IF;

  SELECT quota_used_bytes INTO n FROM entitlements WHERE id=ent_a;
  IF n<>1024 THEN RAISE EXCEPTION 'double billed A: %',n; END IF;
  IF EXISTS (SELECT 1 FROM entitlements WHERE id=ent_a AND quota_state<>'EXHAUSTED') THEN
    RAISE EXCEPTION 'quota A not exhausted';
  END IF;
  SELECT record_smart_dns_measured_traffic(ent_a,'overcap',0,1) INTO result;
  IF result NOT IN ('DENY_INACTIVE','DENY_QUOTA') THEN
    RAISE EXCEPTION 'overcap allowed: %',result;
  END IF;

  SELECT record_smart_dns_measured_traffic(ent_b,'nov-B',50,150) INTO result;
  IF result <> 'ACCEPTED' THEN RAISE EXCEPTION 'B traffic: %',result; END IF;
  SELECT record_smart_dns_measured_traffic(ent_b,'invalid-empty',0,0) INTO result;
  IF result <> 'DENY_INVALID' THEN RAISE EXCEPTION 'zero event: %',result; END IF;
  SELECT record_smart_dns_measured_traffic(ent_b,'invalid-negative',-1,3) INTO result;
  IF result <> 'DENY_INVALID' THEN RAISE EXCEPTION 'negative event: %',result; END IF;
  SELECT record_smart_dns_measured_traffic(ent_b,'invalid-overflow',
      9223372036854775807::bigint,1) INTO result;
  IF result <> 'DENY_INVALID' THEN RAISE EXCEPTION 'overflow event: %',result; END IF;

  -- Legacy unmatched debits must not be mistaken for measured TCP traffic.
  SELECT debit_smart_dns_quota(ent_b,'legacy-direct-B',5) INTO result;
  IF result <> 'ACCEPTED' THEN RAISE EXCEPTION 'legacy debit: %',result; END IF;
  SELECT record_smart_dns_measured_traffic(ent_b,'legacy-direct-B',0,5) INTO result;
  IF result <> 'DENY_UNATTRIBUTED_EVENT' THEN
    RAISE EXCEPTION 'legacy counter converted into measured event: %',result;
  END IF;

  -- Test fixtures only: move canonical usage-event dates to the UTC month
  -- boundary, proving no local timezone contamination and no event loss.
  UPDATE quota_usage_events SET accepted_at='2026-10-31 23:59:59+00'::timestamptz
    WHERE entitlement_id=ent_a AND usage_event_id='oct-A';
  UPDATE quota_usage_events SET accepted_at='2026-11-01 00:00:00+00'::timestamptz
    WHERE entitlement_id=ent_a AND usage_event_id='nov-A';
  UPDATE quota_usage_events SET accepted_at='2026-11-12 12:00:00+00'::timestamptz
    WHERE entitlement_id=ent_b;

  SELECT * INTO report FROM get_smart_dns_monthly_traffic(owner_a,ent_a)
    WHERE month_utc='2026-10-01'::date;
  IF NOT FOUND OR report.upload_bytes<>120 OR report.download_bytes<>280
       OR report.measured_total_bytes<>400 OR report.unattributed_bytes<>0 THEN
    RAISE EXCEPTION 'October breakdown incorrect';
  END IF;
  SELECT * INTO report FROM get_smart_dns_monthly_traffic(owner_a,ent_a)
    WHERE month_utc='2026-11-01'::date;
  IF NOT FOUND OR report.upload_bytes<>240 OR report.download_bytes<>384
       OR report.measured_total_bytes<>624 OR report.unattributed_bytes<>0 THEN
    RAISE EXCEPTION 'November breakdown incorrect';
  END IF;
  SELECT count(*) INTO n FROM get_smart_dns_monthly_traffic(owner_a,ent_a);
  IF n<>2 THEN RAISE EXCEPTION 'October/November boundary wrong: %',n; END IF;

  SELECT * INTO report FROM get_smart_dns_monthly_traffic(owner_b,ent_b);
  IF NOT FOUND OR report.month_utc<>'2026-11-01'::date OR
       report.upload_bytes<>50 OR report.download_bytes<>150 OR
       report.measured_total_bytes<>200 OR report.unattributed_bytes<>5 THEN
    RAISE EXCEPTION 'Unattributed legacy traffic not explicitly marked';
  END IF;
  SELECT count(*) INTO n FROM get_smart_dns_monthly_traffic(owner_b,ent_a);
  IF n<>0 THEN RAISE EXCEPTION 'Owner B leaked A usage'; END IF;
  SELECT count(*) INTO n FROM get_smart_dns_monthly_traffic(owner_a,ent_b);
  IF n<>0 THEN RAISE EXCEPTION 'Owner A leaked B usage'; END IF;
  SELECT quota_used_bytes INTO n FROM entitlements WHERE id=ent_b;
  IF n<>205 THEN RAISE EXCEPTION 'B usage changed by A or reporting: %',n; END IF;

  UPDATE entitlements SET state='EXPIRED' WHERE id=ent_b;
  SELECT record_smart_dns_measured_traffic(ent_b,'expired-B',1,0) INTO result;
  IF result <> 'DENY_INACTIVE' THEN RAISE EXCEPTION 'expired B charged: %',result; END IF;
END $$;
ROLLBACK;
