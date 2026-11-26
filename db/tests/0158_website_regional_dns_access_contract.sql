BEGIN;
DO $test$
DECLARE
 a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); o uuid:=gen_random_uuid(); e uuid:=gen_random_uuid();
 sa text:=encode(sha256(convert_to(a::text,'UTF8')),'hex');
 sb text:=encode(sha256(convert_to(b::text,'UTF8')),'hex');
 de text:=substr(replace(a::text,'-',''),1,12);
 fi text:=substr(replace(b::text,'-',''),1,12);
 fi2 text:=substr(replace(o::text,'-',''),1,12);
 de_hash text;
BEGIN
 INSERT INTO accounts(id) VALUES(a),(b);
 INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
 VALUES(o,a,'smart_dns','fixture',20000,'RUB','PAID');
 INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,dns_query_quota_per_30d)
 VALUES(e,a,o,'smart_dns','ACTIVE',1,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',1000000);
 INSERT INTO website_sessions(token_sha256,account_id,expires_at)
 VALUES(sa,a,clock_timestamp()+interval '1 day'),(sb,b,clock_timestamp()+interval '1 day');
 IF website_regional_dns_status(sa,e) IS NOT NULL THEN RAISE EXCEPTION 'FI before DE'; END IF;
 de_hash:=encode(sha256(convert_to(de,'UTF8')),'hex');
 IF website_issue_personal_dns_credential(sa,e,de,de_hash)<>'ISSUED' THEN RAISE EXCEPTION 'DE issue'; END IF;
 UPDATE fi_dns_meter_gate SET enabled=true WHERE singleton;
 IF website_regional_dns_status(sb,e) IS NOT NULL OR website_issue_regional_dns_credential(sb,e,fi,0)<>'DENY_OWNER' THEN RAISE EXCEPTION 'owner isolation'; END IF;
 IF website_regional_dns_status(sa,e)->>'issued' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'FI status'; END IF;
 IF website_issue_regional_dns_credential(sa,e,fi,0)<>'ISSUED' THEN RAISE EXCEPTION 'FI issue'; END IF;
 IF website_regional_dns_status(sa,e)->>'revision' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'FI revision'; END IF;
 IF website_issue_regional_dns_credential(sa,e,fi2,0)<>'DENY_STALE' THEN RAISE EXCEPTION 'FI stale'; END IF;
 IF website_issue_regional_dns_credential(sa,e,fi2,1)<>'ROTATED' THEN RAISE EXCEPTION 'FI rotate'; END IF;
 IF NOT EXISTS(SELECT 1 FROM personal_dns_credentials WHERE entitlement_id=e AND token_sha256=de_hash) THEN RAISE EXCEPTION 'DE changed'; END IF;
 UPDATE website_sessions SET revoked_at=clock_timestamp() WHERE token_sha256=sa;
 IF website_regional_dns_status(sa,e) IS NOT NULL OR website_issue_regional_dns_credential(sa,e,fi,2)<>'DENY_OWNER' THEN RAISE EXCEPTION 'revoked session'; END IF;
END;
$test$;
ROLLBACK;
