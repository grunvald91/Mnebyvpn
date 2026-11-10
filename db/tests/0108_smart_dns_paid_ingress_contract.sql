-- Issue #84, disposable PostgreSQL-only test. No production node, DNS or
-- payment provider is touched. 0001..0108 migrations are prerequisites.
BEGIN;
DO $$
DECLARE
  account_a uuid := 'c0840000-0000-4000-8000-000000000001';
  account_b uuid := 'c0840000-0000-4000-8000-000000000002';
  order_a uuid := 'c0840000-0000-4000-8000-000000000003';
  order_b uuid := 'c0840000-0000-4000-8000-000000000004';
  order_unpaid uuid := 'c0840000-0000-4000-8000-000000000005';
  entitlement_unpaid uuid := 'c0840000-0000-4000-8000-000000000006';
  entitlement_a uuid;
  entitlement_b uuid;
  found_id uuid;
  remaining bigint;
  result text;
BEGIN
  INSERT INTO accounts(id) VALUES(account_a),(account_b);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
    VALUES(order_a,account_a,'smart_dns','mock',10000,'RUB'),
          (order_b,account_b,'smart_dns','mock',10000,'RUB');

  SELECT settle_verified_payment(order_a,'mock','e84-a','tx84-a',repeat('a',64),
                                 10000,'RUB',3600,1000) INTO result;
  IF result <> 'APPLIED' THEN RAISE EXCEPTION 'paid A rejected: %',result; END IF;
  SELECT settle_verified_payment(order_b,'mock','e84-b','tx84-b',repeat('b',64),
                                 10000,'RUB',3600,1000) INTO result;
  IF result <> 'APPLIED' THEN RAISE EXCEPTION 'paid B rejected: %',result; END IF;
  SELECT id INTO entitlement_a FROM entitlements WHERE source_order_id=order_a;
  SELECT id INTO entitlement_b FROM entitlements WHERE source_order_id=order_b;
  IF entitlement_a IS NULL OR entitlement_b IS NULL THEN
    RAISE EXCEPTION 'missing DNS entitlements';
  END IF;
  IF claim_smart_dns_ipv6(entitlement_a,'2001:db8::84a'::inet) <> 'BOUND' OR
     claim_smart_dns_ipv6(entitlement_b,'2001:db8::84b'::inet) <> 'BOUND' THEN
    RAISE EXCEPTION 'personal destination claim failed';
  END IF;

  -- Paid + bound is NOT sufficient. Must wait for observed ingress provisioning.
  IF EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress('2001:db8::84a'::inet)) THEN
    RAISE EXCEPTION 'premature access before node ACK';
  END IF;
  INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at)
    SELECT e.id,'smart_dns',e.revision,clock_timestamp()
      FROM entitlements e WHERE e.id IN (entitlement_a,entitlement_b);

  SELECT t.entitlement_id,t.remaining_bytes INTO found_id,remaining
    FROM authorize_paid_smart_dns_ingress('2001:db8::84a'::inet) AS t;
  IF found_id IS DISTINCT FROM entitlement_a OR remaining <> 1000 THEN
    RAISE EXCEPTION 'incorrect A attribution or quota';
  END IF;
  SELECT t.entitlement_id,t.remaining_bytes INTO found_id,remaining
    FROM authorize_paid_smart_dns_ingress('2001:db8::84b'::inet) AS t;
  IF found_id IS DISTINCT FROM entitlement_b OR remaining <> 1000 THEN
    RAISE EXCEPTION 'incorrect B attribution or quota';
  END IF;
  IF EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress('2001:db8::84f'::inet))
     OR EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress('192.0.2.84'::inet))
     OR EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress('2001:db8::/64'::inet))
     OR EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress(NULL::inet)) THEN
    RAISE EXCEPTION 'unknown/IPv4/subnet/null destination admitted';
  END IF;

  -- A crafted ACTIVE entitlement without any verified paid credit is denied,
  -- even if an operator mistakenly marks its provisioning as observed.
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
    VALUES(order_unpaid,account_a,'smart_dns','mock',10000,'RUB');
  INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,
                           starts_at,expires_at,quota_limit_bytes)
    VALUES(entitlement_unpaid,account_a,order_unpaid,'smart_dns','ACTIVE',1,
           clock_timestamp(),clock_timestamp()+interval '1 hour',1000);
  IF claim_smart_dns_ipv6(entitlement_unpaid,'2001:db8::84c'::inet) <> 'BOUND' THEN
    RAISE EXCEPTION 'test fixture claim failed';
  END IF;
  INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at)
    VALUES(entitlement_unpaid,'smart_dns',1,clock_timestamp());
  IF EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress('2001:db8::84c'::inet)) THEN
    RAISE EXCEPTION 'unpaid/creditless DNS entitlement admitted';
  END IF;

  -- Debiting B does not change A; the predicate reads the real stored balance.
  SELECT debit_smart_dns_quota(entitlement_b,'e84-b-400',400) INTO result;
  IF result <> 'ACCEPTED' THEN RAISE EXCEPTION 'B debit: %',result; END IF;
  SELECT t.remaining_bytes INTO remaining
    FROM authorize_paid_smart_dns_ingress('2001:db8::84b'::inet) t;
  IF remaining <> 600 THEN RAISE EXCEPTION 'B remaining quota: %',remaining; END IF;
  SELECT t.remaining_bytes INTO remaining
    FROM authorize_paid_smart_dns_ingress('2001:db8::84a'::inet) t;
  IF remaining <> 1000 THEN RAISE EXCEPTION 'B debit affected A'; END IF;

  -- A stale observed revision may never resurrect an older ENABLE.
  UPDATE entitlements SET revision=revision+1 WHERE id=entitlement_a;
  IF EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress('2001:db8::84a'::inet)) THEN
    RAISE EXCEPTION 'stale provisioning revision admitted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress('2001:db8::84b'::inet)) THEN
    RAISE EXCEPTION 'stale A revision affected B';
  END IF;

  -- Even if expiry worker hasn't run, a past deadline fails closed.
  UPDATE entitlements SET starts_at=clock_timestamp()-interval '2 hours',
                          expires_at=clock_timestamp()-interval '1 second'
    WHERE id=entitlement_b;
  IF EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress('2001:db8::84b'::inet)) THEN
    RAISE EXCEPTION 'expired DNS entitlement admitted';
  END IF;
  UPDATE entitlements SET starts_at=clock_timestamp()-interval '1 minute',
                          expires_at=clock_timestamp()+interval '1 hour'
    WHERE id=entitlement_b;

  -- Exhausting a paid bucket denies NEW admission without a DNS cache purge.
  SELECT debit_smart_dns_quota(entitlement_b,'e84-b-600',600) INTO result;
  IF result <> 'ACCEPTED' THEN RAISE EXCEPTION 'B exhaustion debit: %',result; END IF;
  IF EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress('2001:db8::84b'::inet)) THEN
    RAISE EXCEPTION 'exhausted DNS entitlement admitted';
  END IF;

  -- Retire A: no direct TCP reuse, no replacement and no resurrection.
  IF NOT retire_smart_dns_ipv6(entitlement_a) THEN RAISE EXCEPTION 'retire failed'; END IF;
  UPDATE entitlements SET revision=revision+1 WHERE id=entitlement_a;
  UPDATE provisioning_state SET applied_revision=(SELECT revision FROM entitlements
       WHERE id=entitlement_a),last_observed_at=clock_timestamp()
    WHERE entitlement_id=entitlement_a AND adapter='smart_dns';
  IF EXISTS (SELECT 1 FROM authorize_paid_smart_dns_ingress('2001:db8::84a'::inet)) THEN
    RAISE EXCEPTION 'retired bearer address admitted';
  END IF;
  IF claim_smart_dns_ipv6(entitlement_unpaid,'2001:db8::84a'::inet) <> 'DENY_ALREADY_CLAIMED' THEN
    RAISE EXCEPTION 'unpaid fixture unexpectedly re-bound';
  END IF;

  BEGIN
    DELETE FROM smart_dns_ipv6_claims WHERE entitlement_id=entitlement_a;
    RAISE EXCEPTION 'tombstone was deleted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE smart_dns_ipv6_claims
      SET destination_ipv6='2001:db8::ffff'::inet WHERE entitlement_id=entitlement_a;
    RAISE EXCEPTION 'tombstone was reassigned';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE smart_dns_ipv6_claims SET retired_at=NULL
      WHERE entitlement_id=entitlement_a;
    RAISE EXCEPTION 'tombstone was revived';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;
ROLLBACK;
