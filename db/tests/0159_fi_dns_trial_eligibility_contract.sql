BEGIN;
DO $test$
DECLARE
 a uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); e uuid:=gen_random_uuid();
 actor bigint:=930159000001;
 at_time timestamptz:=clock_timestamp()-interval '1 minute';
 ss text:=encode(sha256(convert_to(a::text,'UTF8')),'hex');
 de text:=substr(replace(a::text,'-',''),1,12);
 fi text:=substr(replace(o::text,'-',''),1,12);
 digest text; req uuid:=gen_random_uuid(); req2 uuid:=gen_random_uuid();
BEGIN
 INSERT INTO accounts(id,telegram_user_id) VALUES(a,actor);
 INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
 VALUES(o,a,'smart_dns','internal_trial',0,'XTR','TRIAL');
 INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,quota_limit_bytes)
 VALUES(e,a,o,'smart_dns','ACTIVE',1,at_time,at_time+interval '24 hours',1073741824);
 INSERT INTO website_sessions(token_sha256,account_id,expires_at) VALUES(ss,a,clock_timestamp()+interval '1 day');
 IF website_issue_personal_dns_credential(ss,e,de,encode(sha256(convert_to(de,'UTF8')),'hex'))<>'ISSUED' THEN RAISE EXCEPTION 'DE trial issue'; END IF;
 UPDATE fi_dns_meter_gate SET enabled=true WHERE singleton;
 IF website_regional_dns_status(ss,e) IS NOT NULL OR telegram_regional_dns_revision(actor,'FI') IS NOT NULL THEN RAISE EXCEPTION 'trial without grant'; END IF;
 INSERT INTO trial_grants(account_id,order_id,product,telegram_user_id,activated_at,access_expires_at)
 VALUES(a,o,'smart_dns',actor,at_time,at_time+interval '24 hours');
 IF website_regional_dns_status(ss,e)->>'issued' IS DISTINCT FROM 'false' OR telegram_regional_dns_revision(actor,'FI') IS DISTINCT FROM 0::bigint THEN RAISE EXCEPTION 'trial menus'; END IF;
 IF website_issue_regional_dns_credential(ss,e,fi,0)<>'ISSUED' THEN RAISE EXCEPTION 'FI trial issue'; END IF;
 SELECT token_sha256 INTO digest FROM fi_dns_regional_credentials WHERE entitlement_id=e;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fi_dns_snapshot_next()->'grants') g WHERE g->>'tokenSha256'=digest) THEN RAISE EXCEPTION 'trial snapshot missing'; END IF;
 IF reserve_personal_dns_query(de,req)<>'RESERVED' THEN RAISE EXCEPTION 'DE reserve'; END IF;
 IF finish_personal_dns_query(req,true)<>'SETTLED' THEN RAISE EXCEPTION 'DE settle'; END IF;
 IF fi_dns_meter_apply('reserve',req2,digest)<>'RESERVED' THEN RAISE EXCEPTION 'FI reserve'; END IF;
 IF fi_dns_meter_apply('settle',req2)<>'SETTLED' THEN RAISE EXCEPTION 'FI settle'; END IF;
 IF NOT EXISTS(SELECT 1 FROM personal_dns_query_windows WHERE entitlement_id=e AND period_index=0 AND used_queries=2 AND reserved_queries=0) THEN RAISE EXCEPTION 'shared trial counter'; END IF;
 UPDATE entitlements SET expires_at=at_time+interval '25 hours' WHERE id=e;
 IF fi_dns_entitlement_eligible(e,clock_timestamp()) THEN RAISE EXCEPTION 'trial extension accepted'; END IF;
 UPDATE entitlements SET starts_at=at_time-interval '24 hours',expires_at=at_time WHERE id=e;
 UPDATE trial_grants SET activated_at=at_time-interval '24 hours',access_expires_at=at_time WHERE order_id=o;
 IF website_regional_dns_status(ss,e) IS NOT NULL OR telegram_regional_dns_revision(actor,'FI') IS NOT NULL THEN RAISE EXCEPTION 'expired menus'; END IF;
 IF fi_dns_meter_apply('reserve',gen_random_uuid(),digest)<>'DENY_INACTIVE' THEN RAISE EXCEPTION 'expired meter'; END IF;
 IF reserve_personal_dns_query(de,gen_random_uuid())='RESERVED' THEN RAISE EXCEPTION 'expired DE meter'; END IF;
 IF website_personal_dns_status(ss,e) IS NOT NULL THEN RAISE EXCEPTION 'expired DE profile status'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(fi_dns_snapshot_next()->'grants') g WHERE g->>'tokenSha256'=digest) THEN RAISE EXCEPTION 'expired snapshot grant'; END IF;
END;
$test$;
ROLLBACK;
