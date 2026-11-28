BEGIN;
DO $test$
DECLARE a uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); v uuid:=gen_random_uuid();
 po uuid:=gen_random_uuid(); pe uuid:=gen_random_uuid();
 t timestamptz:=clock_timestamp()-interval '1 minute';
 actor bigint:=8898765432;
 de text:=substr(replace(e::text,'-',''),1,12); fi text:=substr(replace(v::text,'-',''),1,12);
 rotated text:=substr(replace(o::text,'-',''),1,12);
 s jsonb;
BEGIN
 INSERT INTO accounts(id,telegram_user_id) VALUES(a,actor);
 INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
 VALUES(o,a,'bundle','internal_trial',0,'XTR','TRIAL'),(po,a,'smart_dns','fixture',20000,'RUB','PAID');
 INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,quota_limit_bytes,dns_query_quota_per_30d)
 VALUES(e,a,o,'smart_dns','ACTIVE',1,t,t+interval '24 hours',1073741824,NULL),
 (v,a,o,'vpn','ACTIVE',1,t,t+interval '24 hours',NULL,NULL),
 (pe,a,po,'smart_dns','ACTIVE',1,t,t+interval '30 days',NULL,1000000);
 INSERT INTO trial_grants(account_id,order_id,product,telegram_user_id,activated_at,access_expires_at)
 VALUES(a,o,'bundle',actor,t,t+interval '24 hours');
 UPDATE fi_dns_meter_gate SET enabled=true WHERE singleton;
 UPDATE entitlements SET state='SUSPENDED' WHERE id=v;
 IF telegram_bundle_trial_dns_status(actor) IS NOT NULL OR telegram_bundle_trial_dns_issue(actor,'DE',de,0)<>'DENY_INACTIVE'
 THEN RAISE EXCEPTION 'incomplete joint access'; END IF;
 UPDATE entitlements SET state='ACTIVE' WHERE id=v;
 s:=telegram_bundle_trial_dns_status(actor);
 IF s IS DISTINCT FROM '{"deRevision":0,"fiRevision":null}'::jsonb THEN RAISE EXCEPTION 'initial status %',s; END IF;
 IF telegram_bundle_trial_dns_issue(actor+1,'DE',de,0)<>'DENY_INACTIVE' THEN RAISE EXCEPTION 'cross-owner access'; END IF;
 IF telegram_bundle_trial_dns_issue(actor,'DE',de,0)<>'ISSUED' THEN RAISE EXCEPTION 'DE issue failed'; END IF;
 IF telegram_bundle_trial_dns_issue(actor,'FI',fi,0)<>'ISSUED' THEN RAISE EXCEPTION 'FI issue failed'; END IF;
 s:=telegram_bundle_trial_dns_status(actor);
 IF s IS DISTINCT FROM '{"deRevision":1,"fiRevision":1}'::jsonb THEN RAISE EXCEPTION 'issued status %',s; END IF;
 IF telegram_bundle_trial_dns_issue(actor,'FI',rotated,1)<>'ROTATED' THEN RAISE EXCEPTION 'FI rotate failed'; END IF;
 IF telegram_bundle_trial_dns_issue(actor,'FI',fi,1)<>'DENY_STALE' THEN RAISE EXCEPTION 'stale callback rotated'; END IF;
 INSERT INTO personal_dns_query_windows(entitlement_id,period_index,used_queries,reserved_queries) VALUES(e,0,25,0);
 IF telegram_bundle_trial_dns_issue(actor,'DE',rotated,1)<>'ROTATED' THEN RAISE EXCEPTION 'DE rotate failed'; END IF;
 IF telegram_bundle_trial_dns_issue(actor,'DE',de,1)<>'DENY_STALE' THEN RAISE EXCEPTION 'DE stale callback'; END IF;
 IF (SELECT used_queries FROM personal_dns_query_windows WHERE entitlement_id=e AND period_index=0) IS DISTINCT FROM 25::bigint
 OR (SELECT credential_revision FROM fi_dns_regional_credentials WHERE entitlement_id=e) IS DISTINCT FROM 2::bigint
 THEN RAISE EXCEPTION 'DE rotation changed shared usage or FI revision'; END IF;
 IF EXISTS(SELECT 1 FROM personal_dns_credentials WHERE entitlement_id=pe) THEN RAISE EXCEPTION 'paid profile touched'; END IF;
 IF (SELECT query_limit_per_30d FROM personal_dns_credentials WHERE entitlement_id=e) IS DISTINCT FROM 30000::bigint THEN RAISE EXCEPTION 'trial quota'; END IF;
 UPDATE entitlements SET starts_at=t-interval '24 hours',expires_at=t WHERE id IN(e,v);
 UPDATE trial_grants SET activated_at=t-interval '24 hours',access_expires_at=t WHERE order_id=o;
 IF telegram_bundle_trial_dns_status(actor) IS NOT NULL OR telegram_bundle_trial_dns_issue(actor,'FI',fi,2)<>'DENY_INACTIVE'
 THEN RAISE EXCEPTION 'expired access'; END IF;
END $test$;
ROLLBACK;
