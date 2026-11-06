-- Run only on a disposable PostgreSQL database with migration 0001 + 0002.
-- A single client transaction rolls all fixture data back. This does NOT
-- replace separate multi-client concurrency/lease/failover tests.
BEGIN;
DO $$
DECLARE
  a uuid := 'c1bef4d3-0000-4000-8000-000000000001';
  o uuid := 'c1bef4d3-0000-4000-8000-000000000002';
  o2 uuid := 'c1bef4d3-0000-4000-8000-000000000003';
  e_id uuid;
  v text;
  tok bigint;
  tok2 bigint;
  count_found integer;
BEGIN
  INSERT INTO accounts(id) VALUES(a);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
    VALUES (o,a,'bundle','fake-provider',29900,'RUB'),
           (o2,a,'smart_dns','fake-provider',19900,'RUB');

  SELECT settle_verified_payment(o,'fake-provider','paid-event-1','capture-1',repeat('a',64),
                                 29900,'RUB',3600,1024) INTO v;
  IF v <> 'APPLIED' THEN RAISE EXCEPTION 'settlement failed: %',v; END IF;
  SELECT count(*) INTO count_found FROM entitlements WHERE source_order_id=o;
  IF count_found <> 2 THEN RAISE EXCEPTION 'bundle failed'; END IF;
  SELECT count(*) INTO count_found FROM reconcile_outbox
    WHERE entitlement_id IN (SELECT id FROM entitlements WHERE source_order_id=o);
  IF count_found <> 2 THEN RAISE EXCEPTION 'outbox missing'; END IF;

  SELECT settle_verified_payment(o,'fake-provider','paid-event-1','capture-1',repeat('a',64),
                                 29900,'RUB',3600,1024) INTO v;
  IF v <> 'DUPLICATE_EVENT' THEN RAISE EXCEPTION 'duplicate payment: %',v; END IF;
  SELECT settle_verified_payment(o,'fake-provider','paid-event-1','capture-1',repeat('f',64),
                                 29900,'RUB',3600,1024) INTO v;
  IF v <> 'DUPLICATE_EVENT' THEN RAISE EXCEPTION 'modified retry not idempotent: %',v; END IF;
  -- A second signed notification event for the SAME capture must not extend term.
  SELECT settle_verified_payment(o,'fake-provider','retry-event-2','capture-1',repeat('e',64),
                                 29900,'RUB',3600,1024) INTO v;
  IF v <> 'DUPLICATE_CAPTURE' THEN RAISE EXCEPTION 'redelivery capture: %',v; END IF;
  SELECT settle_verified_payment(o2,'fake-provider','paid-event-2','capture-1',repeat('b',64),
                                 19900,'RUB',3600,200) INTO v;
  IF v <> 'DENY_CAPTURE_REUSED' THEN RAISE EXCEPTION 'capture reused: %',v; END IF;
  SELECT count(*) INTO count_found FROM entitlements WHERE source_order_id=o2;
  IF count_found <> 0 THEN RAISE EXCEPTION 'unauthorized second grant'; END IF;
  -- Independent packages for the SAME account and product; refund of order o
  -- does not revoke the second separately paid Smart DNS package.
  SELECT settle_verified_payment(o2,'fake-provider','paid-event-3','capture-2',repeat('d',64),
                                 19900,'RUB',3600,200) INTO v;
  IF v <> 'APPLIED' THEN RAISE EXCEPTION 'second package: %',v; END IF;
  SELECT count(*) INTO count_found FROM entitlements
    WHERE account_id = a AND product = 'smart_dns';
  IF count_found <> 2 THEN RAISE EXCEPTION 'package isolation: %', count_found; END IF;


  SELECT id INTO e_id FROM entitlements WHERE source_order_id=o AND product='vpn';
  SELECT claim_provisioning_fence(e_id,'vpn') INTO tok;
  SELECT claim_provisioning_fence(e_id,'vpn') INTO tok2;
  IF tok2 <= tok THEN RAISE EXCEPTION 'nonmonotonic fencing'; END IF;
  IF acknowledge_provisioning(e_id,'vpn',1,tok,true) THEN
    RAISE EXCEPTION 'stale fencing accepted';
  END IF;
  IF NOT acknowledge_provisioning(e_id,'vpn',1,tok2,true) THEN
    RAISE EXCEPTION 'latest fencing rejected';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM entitlements WHERE id=e_id AND state='ACTIVE') THEN
    RAISE EXCEPTION 'provisioned entitlement not activated';
  END IF;

  SELECT apply_verified_refund(o,'fake-provider','refund-event-1','capture-1',repeat('c',64)) INTO v;
  IF v <> 'APPLIED' THEN RAISE EXCEPTION 'refund failed: %',v; END IF;
  IF acknowledge_provisioning(e_id,'vpn',1,tok2,true) THEN
    RAISE EXCEPTION 'stale ENABLE ack after refund';
  END IF;
  SELECT count(*) INTO count_found FROM entitlements
   WHERE source_order_id=o AND state='REFUNDED' AND revision=2;
  IF count_found <> 2 THEN RAISE EXCEPTION 'bundle refund incomplete'; END IF;
  IF NOT EXISTS (SELECT 1 FROM entitlements
      WHERE source_order_id=o2 AND state='PAID_PENDING_PROVISIONING' AND revision=1) THEN
    RAISE EXCEPTION 'refund revoked another purchase';
  END IF;

  SELECT count(*) INTO count_found FROM reconcile_outbox
   WHERE entitlement_id IN (SELECT id FROM entitlements WHERE source_order_id=o);
  IF count_found <> 4 THEN RAISE EXCEPTION 'refund outbox signals missing'; END IF;
  SELECT apply_verified_refund(o,'fake-provider','refund-event-1','capture-1',repeat('c',64)) INTO v;
  IF v <> 'DUPLICATE_EVENT' THEN RAISE EXCEPTION 'duplicate refund: %',v; END IF;
  SELECT apply_verified_refund(o,'fake-provider','refund-event-1','capture-1',repeat('e',64)) INTO v;
  IF v <> 'DUPLICATE_EVENT' THEN RAISE EXCEPTION 'modified refund retry not idempotent: %',v; END IF;
  SELECT count(*) INTO count_found FROM payment_delivery_receipts
    WHERE provider='fake-provider' AND transaction_id='capture-1' AND event_kind='PAID';
  IF count_found <> 3 THEN RAISE EXCEPTION 'delivery history lacks redeliveries: %',count_found; END IF;

END;
$$;
ROLLBACK;
