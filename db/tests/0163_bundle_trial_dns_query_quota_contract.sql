-- Rollback-only test: one budget for both regions and no paid plan changes.
BEGIN;
DO $test$
DECLARE
 a uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); e uuid:=gen_random_uuid();
 paid_o uuid:=gen_random_uuid(); paid_e uuid:=gen_random_uuid();
 t timestamptz:=clock_timestamp()-interval '1 minute';
 de text:=substr(replace(a::text,'-',''),1,12);
 fi text:=substr(replace(o::text,'-',''),1,12);
 paid_label text:=substr(replace(paid_o::text,'-',''),1,12);
 new_de text:=substr(replace(e::text,'-',''),1,12);
 digest text; ss text:=encode(sha256(convert_to(a::text,'UTF8')),'hex');
 r1 uuid:=gen_random_uuid(); r2 uuid:=gen_random_uuid(); r3 uuid:=gen_random_uuid();
BEGIN
 INSERT INTO accounts(id) VALUES(a);
 INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
 VALUES(o,a,'bundle','internal_trial',0,'XTR','TRIAL'),
       (paid_o,a,'bundle','fixture',39900,'RUB','PAID');
 INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,quota_limit_bytes,dns_query_quota_per_30d)
 VALUES(e,a,o,'smart_dns','ACTIVE',1,t,t+interval '24 hours',1073741824,NULL),
       (paid_e,a,paid_o,'smart_dns','ACTIVE',1,t,t+interval '30 days',NULL,1000000);
 INSERT INTO website_sessions(token_sha256,account_id,expires_at) VALUES(ss,a,clock_timestamp()+interval '1 day');
 IF website_issue_personal_dns_credential(ss,e,de,encode(sha256(convert_to(de,'UTF8')),'hex'))<>'DENY_INACTIVE'
 THEN RAISE EXCEPTION 'Trial issuance before canonical activation'; END IF;
 INSERT INTO trial_grants(account_id,order_id,product,activated_at,access_expires_at)
 VALUES(a,o,'bundle',t,t+interval '24 hours');
 IF website_issue_personal_dns_credential(ss,e,de,encode(sha256(convert_to(de,'UTF8')),'hex'))<>'ISSUED'
 THEN RAISE EXCEPTION 'Trial DE issuance failed'; END IF;
 IF issue_personal_dns_credential(e,de,encode(sha256(convert_to(de,'UTF8')),'hex'),1000000)<>'ALREADY_ISSUED'
 THEN RAISE EXCEPTION 'Trial issuance not idempotent'; END IF;
 IF issue_personal_dns_credential(paid_e,paid_label,encode(sha256(convert_to(paid_label,'UTF8')),'hex'),1000000)<>'ISSUED'
 THEN RAISE EXCEPTION 'Paid issuance failed'; END IF;
 IF (SELECT query_limit_per_30d FROM personal_dns_credentials WHERE entitlement_id=paid_e) IS DISTINCT FROM 1000000::bigint
 THEN RAISE EXCEPTION 'Paid allowance changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM personal_dns_query_status(e) WHERE allowed_queries=30000 AND remaining_queries=30000)
 THEN RAISE EXCEPTION 'Incorrect initial trial allowance'; END IF;
 UPDATE fi_dns_meter_gate SET enabled=true WHERE singleton;
 IF website_issue_regional_dns_credential(ss,e,fi,0)<>'ISSUED'
 THEN RAISE EXCEPTION 'FI issuance failed'; END IF;
 SELECT token_sha256 INTO digest FROM fi_dns_regional_credentials WHERE entitlement_id=e;
 -- Seed the near-boundary counter; real reservations consume the last slots.
 INSERT INTO personal_dns_query_windows(entitlement_id,period_index,used_queries) VALUES(e,0,29998);
 IF reserve_personal_dns_query(de,r1)<>'RESERVED' THEN RAISE EXCEPTION 'DE slot unavailable'; END IF;
 IF fi_dns_meter_apply('reserve',r2,digest)<>'RESERVED' THEN RAISE EXCEPTION 'FI slot unavailable'; END IF;
 IF reserve_personal_dns_query(de,gen_random_uuid())<>'DENY_QUOTA'
 OR fi_dns_meter_apply('reserve',gen_random_uuid(),digest)<>'DENY_QUOTA'
 THEN RAISE EXCEPTION 'Shared reservations oversubscribed'; END IF;
 IF finish_personal_dns_query(r1,true)<>'SETTLED' THEN RAISE EXCEPTION 'DE settlement failed'; END IF;
 IF fi_dns_meter_apply('release',r2)<>'RELEASED' THEN RAISE EXCEPTION 'FI release failed'; END IF;
 IF fi_dns_meter_apply('reserve',r3,digest)<>'RESERVED' THEN RAISE EXCEPTION 'Released slot not reusable'; END IF;
 IF fi_dns_meter_apply('settle',r3)<>'SETTLED' THEN RAISE EXCEPTION 'FI settlement failed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM personal_dns_query_status(e) WHERE allowed_queries=30000 AND used_queries=30000 AND remaining_queries=0 AND access_status='QUOTA_EXHAUSTED')
 THEN RAISE EXCEPTION 'Shared quota status incorrect'; END IF;
 IF rotate_personal_dns_credential(a,e,1,new_de,encode(sha256(convert_to(new_de,'UTF8')),'hex'))<>'ROTATED'
 THEN RAISE EXCEPTION 'DE rotation failed'; END IF;
 IF reserve_personal_dns_query(new_de,gen_random_uuid())<>'DENY_QUOTA'
 OR fi_dns_meter_apply('reserve',gen_random_uuid(),digest)<>'DENY_QUOTA'
 THEN RAISE EXCEPTION 'Rotation reset budget'; END IF;
END;
$test$;
ROLLBACK;
