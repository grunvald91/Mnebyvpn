-- Isolated PostgreSQL fixture: every state change rolled back.
BEGIN;
DO $test$
DECLARE
 ent uuid:='70707070-7777-4777-8777-777777777777';
 ord uuid:='80808080-8888-4888-8888-888888888888';
 acc uuid:='90909090-9999-4999-8999-999999999999';
 a uuid:='11111111-1111-4111-8111-111111111111';
 b uuid:='22222222-2222-4222-8222-222222222222';
 c uuid:='33333333-3333-4333-8333-333333333333';
 d uuid:='44444444-4444-4444-8444-444444444444';
BEGIN
 IF (SELECT enabled FROM vpn_release_flags
     WHERE feature='vpn_shared_connection_admission') IS DISTINCT FROM false
 OR EXISTS(SELECT 1 FROM vpn_shared_connection_nodes) THEN
   RAISE EXCEPTION 'Admission not dormant on initial schema'; END IF;
 INSERT INTO accounts(id) VALUES(acc);
 INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
 VALUES(ord,acc,'bundle','telegram_stars',500,'XTR','PAID');
 INSERT INTO order_terms(order_id,plan_id,plan_title,duration_seconds,
  dns_quota_bytes,expires_at,device_limit)
 VALUES(ord,'bundle_30d_3device','Test limit',2592000,1000000,
   clock_timestamp()+interval '1 month',3);
 INSERT INTO entitlements(id,account_id,source_order_id,product,state,
  revision,starts_at,expires_at)
 VALUES(ent,acc,ord,'vpn','ACTIVE',1,clock_timestamp()-interval '1 minute',
   clock_timestamp()+interval '1 day');
 INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at)
 VALUES(ent,'vpn',1,clock_timestamp());
 INSERT INTO vpn_shared_connection_nodes(node_id,country_code,node_public_key_sha256,enabled)
 VALUES('test-de','DE',repeat('a',64),true),('test-fi','FI',repeat('b',64),true);
 IF vpn_shared_connection_claim(ent,a,'test-de',repeat('c',64))<>'DENY_DISABLED'
 THEN RAISE EXCEPTION 'Disabled admission allowed'; END IF;
 UPDATE vpn_release_flags SET enabled=true
  WHERE feature='vpn_shared_connection_admission';
 IF vpn_shared_connection_claim(ent,a,'test-de',repeat('c',64))<>'ADMITTED'
 OR vpn_shared_connection_claim(ent,b,'test-fi',repeat('d',64))<>'ADMITTED'
 OR vpn_shared_connection_claim(ent,c,'test-fi',repeat('e',64))<>'ADMITTED'
 THEN RAISE EXCEPTION 'DE+FI must share three admissions'; END IF;
 IF vpn_shared_connection_claim(ent,d,'test-de',repeat('f',64))<>'DENY_LIMIT'
 THEN RAISE EXCEPTION 'Fourth session allowed'; END IF;
 IF vpn_shared_connection_claim(ent,b,'test-fi',repeat('d',64))<>'REFRESHED'
 THEN RAISE EXCEPTION 'Heartbeat not idempotent'; END IF;
 IF vpn_shared_connection_claim(ent,a,'test-fi',repeat('c',64))<>'DENY_REPLAY'
 THEN RAISE EXCEPTION 'Cross-node replay allowed'; END IF;
 IF vpn_shared_connection_release(ent,b,'test-de',repeat('d',64))<>'DENY_BINDING'
 THEN RAISE EXCEPTION 'Foreign node released lease'; END IF;
 IF vpn_shared_connection_release(ent,b,'test-fi',repeat('d',64))<>'RELEASED'
 OR vpn_shared_connection_claim(ent,d,'test-de',repeat('f',64))<>'ADMITTED'
 THEN RAISE EXCEPTION 'Disconnect did not free global place'; END IF;
 IF vpn_shared_connection_claim(ent,b,'test-fi',repeat('d',64))<>'DENY_REPLAY'
 THEN RAISE EXCEPTION 'Old ID was resurrected'; END IF;
 UPDATE orders SET state='REFUNDED' WHERE id=ord;
 IF vpn_shared_connection_claim(ent,gen_random_uuid(),'test-fi',repeat('f',64))
    <>'DENY_ENTITLEMENT'
 THEN RAISE EXCEPTION 'Refunded order admitted'; END IF;
 IF vpn_shared_connection_release(ent,a,'test-de',repeat('c',64))<>'RELEASED'
 THEN RAISE EXCEPTION 'Cannot revoke after refund'; END IF;
END $test$;
DO $acl$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='mnebyvpn_site_auth')
   AND has_function_privilege('mnebyvpn_site_auth',
     'public.vpn_shared_connection_claim(uuid,uuid,text,text)','EXECUTE') THEN
     RAISE EXCEPTION 'Website can grant connection access'; END IF;
 IF NOT has_function_privilege('mnebyvpn_connection_admission',
     'public.vpn_shared_connection_claim(uuid,uuid,text,text)','EXECUTE') THEN
     RAISE EXCEPTION 'Dedicated offline controller role lacks privilege'; END IF;
END $acl$;
ROLLBACK;
