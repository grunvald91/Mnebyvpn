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
  IF v <> 'DENY_EVENT_REUSED' THEN RAISE EXCEPTION 'modified replay: %',v; END IF;
  SELECT settle_verified_payment(o2,'fake-provider','paid-event-2','capture-1',repeat('b',64),
                                 19900,'RUB',3600,200) INTO v;
  IF v <> 'DENY_CAPTURE_REUSED' THEN RAISE EXCEPTION 'capture reused: %',v; END IF;
  SELECT count(*) INTO count_found FROM entitlements WHERE source_order_id=o2;
  IF count_found <> 0 THEN RAISE EXCEPTION 'unauthorized second grant'; END IF;

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
  SELECT count(*) INTO count_found FROM reconcile_outbox
   WHERE entitlement_id IN (SELECT id FROM entitlements WHERE source_order_id=o);
  IF count_found <> 4 THEN RAISE EXCEPTION 'refund outbox signals missing'; END IF;
  SELECT apply_verified_refund(o,'fake-provider','refund-event-1','capture-1',repeat('c',64)) INTO v;
  IF v <> 'DUPLICATE_EVENT' THEN RAISE EXCEPTION 'duplicate refund: %',v; END IF;
  SELECT apply_verified_refund(o,'fake-provider','refund-event-1','capture-1',repeat('e',64)) INTO v;
  IF v <> 'DENY_EVENT_REUSED' THEN RAISE EXCEPTION 'modified refund replay: %',v; END IF;
END;
$$;
ROLLBACK;
