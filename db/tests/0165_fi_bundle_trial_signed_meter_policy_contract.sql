BEGIN;
DO $test$
DECLARE
 a uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); e uuid:=gen_random_uuid();
 paid_o uuid:=gen_random_uuid(); paid_e uuid:=gen_random_uuid();
 t timestamptz:=clock_timestamp()-interval '1 minute';
 de text:=substr(replace(a::text,'-',''),1,12);
 fi text:=substr(replace(o::text,'-',''),1,12);
 paid_de text:=substr(replace(paid_e::text,'-',''),1,12);
 paid_fi text:=substr(replace(paid_o::text,'-',''),1,12);
 snap jsonb;
BEGIN
 INSERT INTO accounts(id) VALUES(a);
 INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
 VALUES(o,a,'bundle','internal_trial',0,'XTR','TRIAL'),
       (paid_o,a,'bundle','fixture',39900,'RUB','PAID');
 INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,quota_limit_bytes,dns_query_quota_per_30d)
 VALUES(e,a,o,'smart_dns','ACTIVE',1,t,t+interval '24 hours',1073741824,NULL),
       (paid_e,a,paid_o,'smart_dns','ACTIVE',1,t,t+interval '30 days',NULL,1000000);
 INSERT INTO trial_grants(account_id,order_id,product,activated_at,access_expires_at)
 VALUES(a,o,'bundle',t,t+interval '24 hours');
 IF issue_personal_dns_credential(e,de,encode(sha256(convert_to(de,'UTF8')),'hex'),1000000)<>'ISSUED'
 THEN RAISE EXCEPTION 'trial issue'; END IF;
 IF issue_personal_dns_credential(paid_e,paid_de,encode(sha256(convert_to(paid_de,'UTF8')),'hex'),1000000)<>'ISSUED'
 THEN RAISE EXCEPTION 'paid issue'; END IF;
 UPDATE fi_dns_meter_gate SET enabled=true WHERE singleton;
 IF issue_regional_dns_credential(a,e,'FI',fi,0)<>'ISSUED'
 OR issue_regional_dns_credential(a,paid_e,'FI',paid_fi,0)<>'ISSUED'
 THEN RAISE EXCEPTION 'regional issuance failed'; END IF;
 snap:=fi_dns_snapshot_next();
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snap->'grants') g WHERE g->>'entitlementId'=e::text AND g->>'state'='ACTIVE_TRIAL')
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snap->'grants') g WHERE g->>'entitlementId'=paid_e::text AND g->>'state'='ACTIVE')
 THEN RAISE EXCEPTION 'incorrect signed accounting mode'; END IF;
 UPDATE entitlements SET expires_at=t WHERE id=e;
 snap:=fi_dns_snapshot_next();
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(snap->'grants') g WHERE g->>'entitlementId'=e::text)
 THEN RAISE EXCEPTION 'expired trial grant published'; END IF;
END;
$test$;
ROLLBACK;
