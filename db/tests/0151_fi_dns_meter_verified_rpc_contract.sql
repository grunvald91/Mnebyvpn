-- Test-only enrolled identity, nonce fences, and scoped role.
BEGIN;
DO $$
DECLARE
 v_key text:=translate(rtrim(encode(decode('302a300506032b6570032100'||repeat('42',32),'hex'),'base64'),'='),'+/','-_');
 v_pin text:=encode(sha256(decode('302a300506032b6570032100'||repeat('42',32),'hex')),'hex');
 v_nonce text:=repeat('d',64);
 v_id uuid:=gen_random_uuid();
BEGIN
 INSERT INTO vpn_node_enrollment_inventory(node_id,endpoint_host,identity_public_spki)
 VALUES('fi-test-01','ci-fi.example.org',v_key);
 UPDATE vpn_node_enrollment_inventory SET status='approved',approved_at=clock_timestamp() WHERE node_id='fi-test-01';
 INSERT INTO vpn_node_enrollment_challenges(challenge_id,node_id,nonce_sha256,issued_at,expires_at,consumed_at)
 VALUES(gen_random_uuid(),'fi-test-01',repeat('e',64),clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 minute',clock_timestamp());
 UPDATE vpn_node_enrollment_inventory SET status='enrolled',enrolled_at=clock_timestamp() WHERE node_id='fi-test-01';
 IF fi_dns_meter_verified_apply('release',v_id,NULL,repeat('a',64),v_nonce,clock_timestamp())<>'DENY_NODE'
 THEN RAISE EXCEPTION 'wrong node key accepted'; END IF;
 IF fi_dns_meter_verified_apply('release',v_id,NULL,v_pin,v_nonce,clock_timestamp()-interval '16 seconds')<>'DENY_INVALID'
 THEN RAISE EXCEPTION 'stale request accepted'; END IF;
 IF fi_dns_meter_verified_apply('reserve',v_id,repeat('b',64),v_pin,v_nonce,clock_timestamp())<>'DENY_DISABLED'
 THEN RAISE EXCEPTION 'disabled gate bypass'; END IF;
 IF fi_dns_meter_verified_apply('release',v_id,NULL,v_pin,v_nonce,clock_timestamp())<>'DENY_REPLAY'
 THEN RAISE EXCEPTION 'nonce replay accepted'; END IF;
 IF fi_dns_meter_verified_apply('release',v_id,NULL,v_pin,repeat('c',64),clock_timestamp())<>'RELEASED'
 THEN RAISE EXCEPTION 'cleanup not available with disabled gate'; END IF;
 UPDATE vpn_node_enrollment_inventory SET status='revoked' WHERE node_id='fi-test-01';
 IF fi_dns_meter_verified_apply('release',v_id,NULL,v_pin,repeat('f',64),clock_timestamp())<>'DENY_NODE'
 THEN RAISE EXCEPTION 'revoked node accepted'; END IF;
 IF has_function_privilege('mnebyvpn_fi_dns_meter','public.fi_dns_meter_apply(text,uuid,text)','EXECUTE')
 OR NOT has_function_privilege('mnebyvpn_fi_dns_meter','public.fi_dns_meter_verified_apply(text,uuid,text,text,text,timestamptz)','EXECUTE')
 OR has_table_privilege('mnebyvpn_fi_dns_meter','public.fi_dns_meter_rpc_nonces','INSERT')
 THEN RAISE EXCEPTION 'unscoped meter role'; END IF;
END $$;
ROLLBACK;
