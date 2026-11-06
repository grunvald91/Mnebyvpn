-- Postgres 0001/0002/0003 required, disposable DB only.
BEGIN;
DO $$
DECLARE
  account_id uuid := 'a4a4a4a4-0000-4000-8000-000000000001';
  order_a uuid := 'a4a4a4a4-0000-4000-8000-000000000002';
  order_b uuid := 'a4a4a4a4-0000-4000-8000-000000000003';
  order_c uuid := 'a4a4a4a4-0000-4000-8000-000000000004';
  entitlement_a uuid;
  entitlement_b uuid;
  entitlement_c uuid;
  v text;
BEGIN
  INSERT INTO accounts(id) VALUES(account_id);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
  VALUES(order_a,account_id,'smart_dns','mock',10000,'RUB'),
        (order_b,account_id,'smart_dns','mock',10000,'RUB'),
        (order_c,account_id,'smart_dns','mock',10000,'RUB');
  SELECT settle_verified_payment(order_a,'mock','event1','tx1',repeat('a',64),
                                 10000,'RUB',3600,1000) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'payment A: %',v; END IF;
  SELECT settle_verified_payment(order_b,'mock','event2','tx2',repeat('b',64),
                                 10000,'RUB',3600,1000) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'payment B: %',v; END IF;
  SELECT id INTO entitlement_a FROM entitlements WHERE source_order_id=order_a;
  SELECT id INTO entitlement_b FROM entitlements WHERE source_order_id=order_b;
  SELECT claim_smart_dns_ipv6(entitlement_a,'2001:db8::a'::inet) INTO v;
  IF v<>'BOUND' THEN RAISE EXCEPTION 'A claim: %',v; END IF;
  SELECT claim_smart_dns_ipv6(entitlement_b,'2001:db8::b'::inet) INTO v;
  IF v<>'BOUND' THEN RAISE EXCEPTION 'B claim: %',v; END IF;
  SELECT claim_smart_dns_ipv6(entitlement_b,'2001:db8::a'::inet) INTO v;
  IF v<>'DENY_ALREADY_CLAIMED' THEN RAISE EXCEPTION 'B attempt second claim: %',v; END IF;
  IF NOT retire_smart_dns_ipv6(entitlement_a) THEN RAISE EXCEPTION 'retire A failed'; END IF;
  SELECT settle_verified_payment(order_c,'mock','event3','tx3',repeat('c',64),
                                 10000,'RUB',3600,1000) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'payment C: %',v; END IF;
  SELECT id INTO entitlement_c FROM entitlements WHERE source_order_id=order_c;
  SELECT claim_smart_dns_ipv6(entitlement_c,'2001:db8::a'::inet) INTO v;
  IF v<>'DENY_ADDRESS_RESERVED' THEN RAISE EXCEPTION 'reused retired IP: %',v; END IF;

  SELECT claim_smart_dns_ipv6(entitlement_a,'2001:db8::a'::inet) INTO v;
  IF v<>'DENY_ALREADY_CLAIMED' THEN RAISE EXCEPTION 'revived retired IP: %',v; END IF;
  -- New subscription is not allowed to acquire an address held by a tombstone.
  UPDATE entitlements SET state='EXPIRED',revision=revision+1 WHERE id=entitlement_b;
  -- Only B is expired. IP of A remains reserved, unique and attached to A.
  IF NOT EXISTS (SELECT 1 FROM smart_dns_ipv6_claims
       WHERE destination_ipv6='2001:db8::a'::inet AND entitlement_id=entitlement_a
         AND retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'missing permanent tombstone';
  END IF;
END; $$;
ROLLBACK;
