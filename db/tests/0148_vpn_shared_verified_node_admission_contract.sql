-- Offline verified admission, temporary fixture fully rolled back.
BEGIN;
DO $fixture$
DECLARE
 aid uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 oid uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 eid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 de_session uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 fi_session uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
BEGIN
 IF EXISTS(SELECT 1 FROM vpn_shared_connection_authorized_peers)
 OR EXISTS(SELECT 1 FROM vpn_shared_connection_nonces)
 OR (SELECT enabled FROM vpn_release_flags WHERE feature='vpn_shared_connection_admission') IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'Verified admission unexpectedly enabled'; END IF;
 INSERT INTO accounts(id) VALUES(aid);
 INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
 VALUES(oid,aid,'vpn','telegram_stars',100,'XTR','PAID');
 INSERT INTO order_terms(order_id,plan_id,plan_title,duration_seconds,expires_at,device_limit)
 VALUES(oid,'vpn_30d_1device','CI Test',2592000,
        clock_timestamp()+interval '30 days',1);
 INSERT INTO entitlements(id,account_id,source_order_id,product,state,
    revision,starts_at,expires_at)
 VALUES(eid,aid,oid,'vpn','ACTIVE',1,
        clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day');
 INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at)
 VALUES(eid,'vpn',1,clock_timestamp());
 INSERT INTO vpn_node_enrollment_inventory(node_id,endpoint_host,
   identity_public_spki,status,approved_at,enrolled_at)
 VALUES('test-de','test-de.example.org',repeat('A',59),'enrolled',
         clock_timestamp(),clock_timestamp()),
       ('test-fi','test-fi.example.org',repeat('B',59),'enrolled',
         clock_timestamp(),clock_timestamp());
 INSERT INTO vpn_shared_connection_nodes(
  node_id,country_code,node_public_key_sha256,enabled)
 VALUES('test-de','DE',repeat('a',64),true),
       ('test-fi','FI',repeat('b',64),true);
 IF vpn_shared_connection_verified_apply(
  eid,de_session,'test-de',repeat('c',64),'claim',repeat('1',64),repeat('e',64)
 )<>'DENY_DISABLED' THEN RAISE EXCEPTION 'Disabled gate admitted a peer'; END IF;
 UPDATE vpn_release_flags SET enabled=true
 WHERE feature='vpn_shared_connection_admission';
 IF vpn_shared_connection_verified_apply(
  eid,de_session,'test-de',repeat('c',64),'claim',repeat('1',64),repeat('e',64)
 )<>'DENY_PEER' THEN RAISE EXCEPTION 'Unbound peer admitted'; END IF;
 INSERT INTO vpn_shared_connection_authorized_peers(entitlement_id,node_id,
  peer_sha256,entitlement_revision,grant_receipt_sha256,verified_at,grant_expires_at)
 VALUES (eid,'test-de',repeat('c',64),1,repeat('d',64),
         clock_timestamp(),clock_timestamp()+interval '1 day'),
        (eid,'test-fi',repeat('e',64),1,repeat('f',64),
         clock_timestamp(),clock_timestamp()+interval '1 day');
 IF vpn_shared_connection_verified_apply(
  eid,de_session,'test-de',repeat('c',64),'claim',repeat('1',64),repeat('e',64)
 )<>'DENY_REPLAY' THEN RAISE EXCEPTION 'A denied nonce was replayed'; END IF;
 IF vpn_shared_connection_verified_apply(
  eid,de_session,'test-de',repeat('c',64),'refresh',repeat('2',64),repeat('e',64)
 )<>'DENY_REPLAY' THEN RAISE EXCEPTION 'Fresh heartbeat minted session'; END IF;
 IF vpn_shared_connection_verified_apply(
  eid,de_session,'test-de',repeat('c',64),'claim',repeat('3',64),repeat('e',64)
 )<>'ADMITTED' THEN RAISE EXCEPTION 'Valid DE node denied'; END IF;
 IF vpn_shared_connection_verified_apply(
  eid,de_session,'test-de',repeat('c',64),'refresh',repeat('4',64),repeat('e',64)
 )<>'REFRESHED' THEN RAISE EXCEPTION 'Valid DE heartbeat denied'; END IF;
 IF vpn_shared_connection_verified_apply(
  eid,fi_session,'test-fi',repeat('e',64),'claim',repeat('5',64),repeat('e',64)
 )<>'DENY_LIMIT' THEN RAISE EXCEPTION 'Global limit was not shared'; END IF;
 UPDATE vpn_shared_connection_authorized_peers SET state='REVOKED'
 WHERE entitlement_id=eid AND node_id='test-de';
 IF vpn_shared_connection_verified_apply(
  eid,de_session,'test-de',repeat('c',64),'refresh',repeat('6',64),repeat('e',64)
 )<>'DENY_PEER' THEN RAISE EXCEPTION 'Revoked peer refreshed'; END IF;
 IF vpn_shared_connection_verified_apply(
  eid,de_session,'test-de',repeat('c',64),'release',repeat('7',64),repeat('e',64)
 )<>'RELEASED' THEN RAISE EXCEPTION 'Release did not free global place'; END IF;
 IF vpn_shared_connection_verified_apply(
  eid,fi_session,'test-fi',repeat('e',64),'claim',repeat('8',64),repeat('e',64)
 )<>'ADMITTED' THEN RAISE EXCEPTION 'FI could not reuse freed capacity'; END IF;
 UPDATE orders SET state='REFUNDED' WHERE id=oid;
 IF vpn_shared_connection_verified_apply(
  eid,gen_random_uuid(),'test-fi',repeat('e',64),'claim',repeat('9',64),repeat('e',64)
 )<>'DENY_ENTITLEMENT' THEN RAISE EXCEPTION 'Refund still permitted admission'; END IF;
 IF vpn_shared_connection_verified_apply(
  eid,fi_session,'test-fi',repeat('e',64),'release',repeat('a',64),repeat('e',64)
 )<>'RELEASED' THEN RAISE EXCEPTION 'Refund prevented session release'; END IF;
END $fixture$;
DO $acl$
BEGIN
 IF has_function_privilege('mnebyvpn_connection_admission',
   'public.vpn_shared_connection_claim(uuid,uuid,text,text)','EXECUTE')
 OR has_function_privilege('mnebyvpn_connection_admission',
   'public.vpn_shared_connection_release(uuid,uuid,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'Old unverified admission remained callable'; END IF;
 IF NOT has_function_privilege('mnebyvpn_connection_admission',
   'public.vpn_shared_connection_verified_apply(uuid,uuid,text,text,text,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'Privileged verified apply is missing'; END IF;
 IF has_table_privilege('mnebyvpn_connection_admission',
   'public.vpn_shared_connection_authorized_peers','INSERT') OR
    has_table_privilege('mnebyvpn_connection_admission',
   'public.vpn_shared_connection_nonces','INSERT')
 THEN RAISE EXCEPTION 'Admission role gained unauthorized write privilege'; END IF;
END $acl$;
ROLLBACK;
