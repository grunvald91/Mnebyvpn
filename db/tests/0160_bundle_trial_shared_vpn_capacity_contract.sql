-- Disposable rollback fixture. No external node or gateway calls.
BEGIN;
DO $test$
DECLARE
 a uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); e uuid:=gen_random_uuid();
 at_time timestamptz:=clock_timestamp()-interval '1 minute';
 s1 uuid:=gen_random_uuid(); s2 uuid:=gen_random_uuid();
 s3 uuid:=gen_random_uuid(); s4 uuid:=gen_random_uuid();
BEGIN
 IF (SELECT enabled FROM vpn_release_flags
     WHERE feature='vpn_shared_connection_admission') IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'Admission gate must start disabled'; END IF;
 INSERT INTO accounts(id) VALUES(a);
 INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
 VALUES(o,a,'bundle','internal_trial',0,'XTR','TRIAL');
 INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at)
 VALUES(e,a,o,'vpn','ACTIVE',1,at_time,at_time+interval '24 hours');
 INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at)
 VALUES(e,'vpn',1,clock_timestamp());
 -- Reuse the existing disposable CI node fixture if present; this SQL
 -- contract runs before any live-node tests and never registers real nodes.
 INSERT INTO vpn_shared_connection_nodes(node_id,country_code,node_public_key_sha256,enabled)
 VALUES('trial-test-de','DE',repeat('a',64),true),('trial-test-fi','FI',repeat('b',64),true);
 IF vpn_shared_connection_claim(e,s1,'trial-test-de',repeat('c',64))<>'DENY_DISABLED'
 THEN RAISE EXCEPTION 'Disabled gate allowed trial'; END IF;
 UPDATE vpn_release_flags SET enabled=true WHERE feature='vpn_shared_connection_admission';
 IF vpn_shared_connection_claim(e,s1,'trial-test-de',repeat('c',64))<>'DENY_ENTITLEMENT'
 THEN RAISE EXCEPTION 'Trial without canonical grant admitted'; END IF;
 INSERT INTO trial_grants(account_id,order_id,product,activated_at,access_expires_at)
 VALUES(a,o,'bundle',at_time,at_time+interval '24 hours');
 IF vpn_shared_connection_claim(e,s1,'trial-test-de',repeat('c',64))<>'ADMITTED'
 OR vpn_shared_connection_claim(e,s2,'trial-test-fi',repeat('d',64))<>'ADMITTED'
 OR vpn_shared_connection_claim(e,s3,'trial-test-fi',repeat('e',64))<>'ADMITTED'
 THEN RAISE EXCEPTION 'Trial did not admit three shared sessions'; END IF;
 IF vpn_shared_connection_claim(e,s4,'trial-test-de',repeat('f',64))<>'DENY_LIMIT'
 THEN RAISE EXCEPTION 'Fourth trial session admitted'; END IF;
 IF vpn_shared_connection_release(e,s2,'trial-test-fi',repeat('d',64))<>'RELEASED'
 OR vpn_shared_connection_claim(e,s4,'trial-test-de',repeat('f',64))<>'ADMITTED'
 THEN RAISE EXCEPTION 'Released regional slot was not reusable'; END IF;
 UPDATE entitlements SET expires_at=at_time+interval '25 hours' WHERE id=e;
 IF vpn_shared_connection_claim(e,s1,'trial-test-de',repeat('c',64))<>'DENY_ENTITLEMENT'
 THEN RAISE EXCEPTION 'Noncanonical trial deadline accepted'; END IF;
 UPDATE entitlements SET starts_at=at_time-interval '24 hours',expires_at=at_time WHERE id=e;
 UPDATE trial_grants SET activated_at=at_time-interval '24 hours',access_expires_at=at_time WHERE order_id=o;
 IF vpn_shared_connection_claim(e,s1,'trial-test-de',repeat('c',64))<>'DENY_ENTITLEMENT'
 THEN RAISE EXCEPTION 'Expired trial lease refreshed'; END IF;
 IF has_function_privilege('mnebyvpn_connection_admission',
   'public.vpn_shared_connection_claim(uuid,uuid,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'Direct unsigned V1 execution restored'; END IF;
END $test$;
ROLLBACK;
