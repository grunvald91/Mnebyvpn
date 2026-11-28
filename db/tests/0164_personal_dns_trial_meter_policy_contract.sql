BEGIN;
DO $test$
DECLARE
 a uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); e uuid:=gen_random_uuid();
 paid_o uuid:=gen_random_uuid(); paid_e uuid:=gen_random_uuid();
 t timestamptz:=clock_timestamp()-interval '1 minute';
 de text:=substr(replace(a::text,'-',''),1,12);
 paid_label text:=substr(replace(paid_o::text,'-',''),1,12);
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
 IF issue_personal_dns_credential(paid_e,paid_label,encode(sha256(convert_to(paid_label,'UTF8')),'hex'),1000000)<>'ISSUED'
 THEN RAISE EXCEPTION 'paid issue'; END IF;
 IF personal_dns_meter_policy(de) IS DISTINCT FROM 'TRIAL'
 OR personal_dns_meter_policy(paid_label) IS DISTINCT FROM 'LEGACY'
 OR personal_dns_meter_policy('invalid') IS DISTINCT FROM 'UNKNOWN'
 THEN RAISE EXCEPTION 'wrong meter policy'; END IF;
 UPDATE entitlements SET starts_at=t-interval '24 hours',expires_at=t WHERE id=e;
 IF personal_dns_meter_policy(de) IS DISTINCT FROM 'TRIAL'
 THEN RAISE EXCEPTION 'expired trial must not fall back to legacy mode'; END IF;
 UPDATE personal_dns_credentials SET revoked_at=clock_timestamp() WHERE entitlement_id=e;
 IF personal_dns_meter_policy(de) IS DISTINCT FROM 'UNKNOWN'
 THEN RAISE EXCEPTION 'revoked trial recognized'; END IF;
END;
$test$;
ROLLBACK;
