-- Disposable rollback fixture. No external node or gateway calls.
BEGIN;
DO $test$
DECLARE
 a uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); e uuid:=gen_random_uuid();
 at_time timestamptz:=clock_timestamp()-interval '1 minute';
 s1 uuid:=gen_random_uuid(); s2 uuid:=gen_random_uuid();
 s3 uuid:=gen_random_uuid(); s4 uuid:=gen_random_uuid();
 de_node text; fi_node text; node text; country text; der bytea; spki text;
 fixture record;
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
 -- The previous concurrency test may leave its disposable enrolled nodes.
 -- If absent, enroll two disposable RFC 8032 public-key fixtures via the
 -- normal state transitions; never disable the identity pin guard.
 FOR fixture IN SELECT * FROM (VALUES
   ('DE','trial-test-de','d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'),
   ('FI','trial-test-fi','3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c')
 ) AS keys(code,node_id,public_hex)
 LOOP
   country:=fixture.code;
   SELECT n.node_id INTO node FROM vpn_shared_connection_nodes n
    WHERE n.country_code=country AND n.enabled;
   IF NOT FOUND THEN
     node:=fixture.node_id;
     der:=decode('302a300506032b6570032100'||fixture.public_hex,'hex');
     spki:=rtrim(translate(encode(der,'base64'),'+/','-_'),'=');
     INSERT INTO vpn_node_enrollment_inventory(node_id,endpoint_host,identity_public_spki)
       VALUES(node,node||'.example.org',spki);
     UPDATE vpn_node_enrollment_inventory SET status='approved',approved_at=clock_timestamp()
       WHERE node_id=node;
     INSERT INTO vpn_node_enrollment_challenges(challenge_id,node_id,nonce_sha256,issued_at,expires_at,consumed_at)
       VALUES(gen_random_uuid(),node,encode(sha256(convert_to(node,'UTF8')),'hex'),
       clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 minute',clock_timestamp());
     UPDATE vpn_node_enrollment_inventory SET status='enrolled',enrolled_at=clock_timestamp()
       WHERE node_id=node;
     INSERT INTO vpn_shared_connection_nodes(node_id,country_code,node_public_key_sha256,enabled)
       VALUES(node,country,encode(sha256(der),'hex'),true);
   END IF;
   IF country='DE' THEN de_node:=node; ELSE fi_node:=node; END IF;
 END LOOP;
 IF vpn_shared_connection_claim(e,s1,de_node,repeat('c',64))<>'DENY_DISABLED'
 THEN RAISE EXCEPTION 'Disabled gate allowed trial'; END IF;
 UPDATE vpn_release_flags SET enabled=true WHERE feature='vpn_shared_connection_admission';
 IF vpn_shared_connection_claim(e,s1,de_node,repeat('c',64))<>'DENY_ENTITLEMENT'
 THEN RAISE EXCEPTION 'Trial without canonical grant admitted'; END IF;
 INSERT INTO trial_grants(account_id,order_id,product,activated_at,access_expires_at)
 VALUES(a,o,'bundle',at_time,at_time+interval '24 hours');
 IF vpn_shared_connection_claim(e,s1,de_node,repeat('c',64))<>'ADMITTED'
 OR vpn_shared_connection_claim(e,s2,fi_node,repeat('d',64))<>'ADMITTED'
 OR vpn_shared_connection_claim(e,s3,fi_node,repeat('e',64))<>'ADMITTED'
 THEN RAISE EXCEPTION 'Trial did not admit three shared sessions'; END IF;
 IF vpn_shared_connection_claim(e,s4,de_node,repeat('f',64))<>'DENY_LIMIT'
 THEN RAISE EXCEPTION 'Fourth trial session admitted'; END IF;
 IF vpn_shared_connection_release(e,s2,fi_node,repeat('d',64))<>'RELEASED'
 OR vpn_shared_connection_claim(e,s4,de_node,repeat('f',64))<>'ADMITTED'
 THEN RAISE EXCEPTION 'Released regional slot was not reusable'; END IF;
 UPDATE entitlements SET expires_at=at_time+interval '25 hours' WHERE id=e;
 IF vpn_shared_connection_claim(e,s1,de_node,repeat('c',64))<>'DENY_ENTITLEMENT'
 THEN RAISE EXCEPTION 'Noncanonical trial deadline accepted'; END IF;
 UPDATE entitlements SET starts_at=at_time-interval '24 hours',expires_at=at_time WHERE id=e;
 UPDATE trial_grants SET activated_at=at_time-interval '24 hours',access_expires_at=at_time WHERE order_id=o;
 IF vpn_shared_connection_claim(e,s1,de_node,repeat('c',64))<>'DENY_ENTITLEMENT'
 THEN RAISE EXCEPTION 'Expired trial lease refreshed'; END IF;
 IF has_function_privilege('mnebyvpn_connection_admission',
   'public.vpn_shared_connection_claim(uuid,uuid,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'Direct unsigned V1 execution restored'; END IF;
END $test$;
ROLLBACK;
