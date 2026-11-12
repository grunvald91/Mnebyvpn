-- Review regressions: late audit, exact idempotency, narrow role, no early release.
-- ONLY disposable PostgreSQL, after 0112.
BEGIN;
DO $$
DECLARE
  a uuid:='c1120000-0000-4000-8000-000000000001';
  b uuid:='c1120000-0000-4000-8000-000000000002';
  o uuid:='c1120000-0000-4000-8000-000000000003';
  e uuid;
  v text;
  stat record;
  audit record;
BEGIN
  INSERT INTO accounts(id) VALUES(a),(b);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
    VALUES(o,a,'smart_dns','mock',10000,'RUB');
  SELECT settle_verified_payment(o,'mock','event-112','capture-112',repeat('a',64),
                                 10000,'RUB',3600,1000) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'setup payment failed %',v; END IF;
  SELECT id INTO e FROM entitlements WHERE source_order_id=o;
  UPDATE entitlements SET state='ACTIVE' WHERE id=e;
  INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at)
    SELECT e,'smart_dns',revision,clock_timestamp()
    FROM entitlements WHERE id=e;

  SELECT * INTO stat FROM dns_ingress_reserve(e,1,'late-112-a',400);
  IF stat.status<>'RESERVED' OR stat.reserved_bytes<>400
      OR stat.entitlement_revision<>1 OR stat.allowed_until<=now() THEN
    RAISE EXCEPTION 'atomic reserve permit incorrect';
  END IF;
  SELECT * INTO stat FROM dns_ingress_reserve(e,1,'late-112-b',600);
  IF stat.status<>'RESERVED' OR stat.reserved_bytes<>600 THEN
    RAISE EXCEPTION 'second atomic reserve incorrect';
  END IF;
  SELECT * INTO stat FROM dns_ingress_reserve(e,1,'late-112-c',1);
  IF stat.status<>'DENY_QUOTA' THEN
    RAISE EXCEPTION 'extra reserve did not fail closed %',stat.status;
  END IF;

  SELECT * INTO audit FROM get_smart_dns_audit_totals(a,e);
  IF audit.held_bytes<>1000 OR audit.late_bytes<>0 THEN
    RAISE EXCEPTION 'unsettled holds must suppress completeness';
  END IF;

  UPDATE entitlements SET state='EXPIRED',revision=revision+1 WHERE id=e;
  SELECT * INTO stat FROM dns_ingress_reserve(e,1,'late-112-d',1);
  IF stat.status<>'DENY_REVISION' THEN
    RAISE EXCEPTION 'stale revision allowed after expiry %',stat.status;
  END IF;

  SELECT dns_ingress_settle(e,999,'late-112-a',100,250) INTO v;
  IF v<>'DENY_REVISION' THEN
    RAISE EXCEPTION 'unowned reservation revision was accepted %',v;
  END IF;
  SELECT dns_ingress_settle(e,1,'late-112-a',100,250) INTO v;
  IF v<>'LATE_RECORDED' THEN RAISE EXCEPTION 'late settlement lost %',v; END IF;
  SELECT dns_ingress_settle(e,1,'late-112-a',100,250) INTO v;
  IF v<>'DUPLICATE' THEN RAISE EXCEPTION 'late retry recharged %',v; END IF;
  SELECT dns_ingress_settle(e,1,'late-112-a',101,249) INTO v;
  IF v<>'DENY_RESERVATION_CONFLICT' THEN
    RAISE EXCEPTION 'conflicting late replay allowed %',v;
  END IF;
  SELECT dns_ingress_settle(e,1,'late-112-b',0,0) INTO v;
  IF v<>'RELEASED' THEN RAISE EXCEPTION 'unspent hold not released %',v; END IF;
  SELECT * INTO audit FROM get_smart_dns_audit_totals(a,e);
  IF NOT FOUND OR audit.held_bytes<>0 OR audit.late_bytes<>350 THEN
    RAISE EXCEPTION 'late/held rollup incorrect';
  END IF;
  IF EXISTS(SELECT 1 FROM get_smart_dns_audit_totals(b,e)) THEN
    RAISE EXCEPTION 'another customer can see audit totals';
  END IF;
  IF EXISTS (SELECT 1 FROM quota_usage_events
     WHERE entitlement_id=e AND usage_event_id='reserve:late-112-a') THEN
    RAISE EXCEPTION 'late audit incorrectly charged refunded credit';
  END IF;
  IF (SELECT quota_used_bytes FROM entitlements WHERE id=e)<>0 THEN
    RAISE EXCEPTION 'late audit corrupted paid quota';
  END IF;
  BEGIN
    DELETE FROM smart_dns_late_traffic WHERE entitlement_id=e;
    RAISE EXCEPTION 'late immutable record was deletable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- A real REFUND occurs between reservation and settlement.
-- The captured wire bytes must remain immutable audit data even though
-- the purchased quota was refunded, and must not be charged a second time.
DO $
DECLARE
  a uuid:='c1120000-0000-4000-8000-000000000011';
  o uuid:='c1120000-0000-4000-8000-000000000012';
  e uuid;
  v text;
  r record;
BEGIN
  INSERT INTO accounts(id) VALUES(a);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
    VALUES(o,a,'smart_dns','mock',10000,'RUB');
  SELECT settle_verified_payment(o,'mock','p112-b','c112-b',repeat('c',64),
    10000,'RUB',3600,500) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'refund setup payment failed %',v; END IF;
  SELECT id INTO e FROM entitlements WHERE source_order_id=o;
  UPDATE entitlements SET state='ACTIVE' WHERE id=e;
  INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at)
    SELECT e,'smart_dns',revision,clock_timestamp() FROM entitlements WHERE id=e;
  SELECT * INTO r FROM dns_ingress_reserve(e,1,'refund-hold-112',500);
  IF r.status<>'RESERVED' THEN RAISE EXCEPTION 'refund reserve failed %',r.status; END IF;
  SELECT apply_verified_refund(o,'mock','refund-112','c112-b',repeat('d',64)) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'refund event failed %',v; END IF;
  SELECT dns_ingress_settle(e,1,'refund-hold-112',120,180) INTO v;
  IF v<>'LATE_RECORDED' THEN RAISE EXCEPTION 'refund raced away traffic %',v; END IF;
  SELECT dns_ingress_settle(e,1,'refund-hold-112',120,180) INTO v;
  IF v<>'DUPLICATE' THEN RAISE EXCEPTION 'refund replay double counted %',v; END IF;
  IF (SELECT quota_used_bytes FROM entitlements WHERE id=e)<>0 THEN
    RAISE EXCEPTION 'refunded credit was charged again'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM smart_dns_late_traffic l
    WHERE l.entitlement_id=e AND l.reservation_id='refund-hold-112'
      AND l.upload_bytes=120 AND l.download_bytes=180
  ) THEN RAISE EXCEPTION 'refunded traffic missing from immutable audit'; END IF;
END $;

DO $
BEGIN
  IF has_table_privilege('mnebyvpn_dns_ingress','public.entitlements','SELECT')
     OR has_table_privilege('mnebyvpn_dns_ingress',
                             'public.smart_dns_quota_reservations','UPDATE')
     OR has_table_privilege('mnebyvpn_dns_ingress',
                             'public.smart_dns_late_traffic','INSERT') THEN
    RAISE EXCEPTION 'ingress role received direct table privileges';
  END IF;
  IF NOT has_function_privilege('mnebyvpn_dns_ingress',
      'public.dns_ingress_reserve(uuid,bigint,text,bigint)','EXECUTE')
     OR has_function_privilege('mnebyvpn_dns_ingress',
      'public.reserve_smart_dns_chunk(uuid,text,bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'ingress role grants too broad or missing';
  END IF;
END $$;
SET LOCAL ROLE mnebyvpn_dns_ingress;
-- A NOLOGIN ingress role can call ONLY approved scoped definer functions.
SELECT dns_ingress_active('c1120000-0000-4000-8000-000000000001'::uuid,1);
RESET ROLE;
ROLLBACK;
