-- Rollback-only real PostgreSQL fixtures; no production connection.
BEGIN;
DO $$
DECLARE
 a uuid:=gen_random_uuid();
 o uuid:=gen_random_uuid();
 e uuid:=gen_random_uuid();
 digest text:=repeat('f',64);
 legacy text:=repeat('g',12);
 r1 uuid:=gen_random_uuid();
 r2 uuid:=gen_random_uuid();
 r3 uuid:=gen_random_uuid();
 r4 uuid:=gen_random_uuid();
 r5 uuid:=gen_random_uuid();
 r6 uuid:=gen_random_uuid();
BEGIN
 INSERT INTO accounts(id) VALUES(a);
 INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
 VALUES(o,a,'smart_dns','fixture',20000,'RUB','PAID');
 INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,dns_query_quota_per_30d)
 VALUES(e,a,o,'smart_dns','ACTIVE',1,clock_timestamp()-interval '1 day',clock_timestamp()+interval '29 days',2);
 IF issue_personal_dns_credential(e,legacy,encode(sha256(convert_to(legacy,'UTF8')),'hex'),2)<>'ISSUED'
 THEN RAISE EXCEPTION 'legacy fixture issue failed'; END IF;
 INSERT INTO fi_dns_regional_credentials(entitlement_id,token_sha256,credential_revision)
 VALUES(e,digest,1);
 IF fi_dns_meter_apply('reserve',r1,digest)<>'DENY_DISABLED'
 THEN RAISE EXCEPTION 'FI gate not default off'; END IF;
 UPDATE fi_dns_meter_gate SET enabled=true;
 IF fi_dns_meter_apply('release',r1)<>'RELEASED'
 OR fi_dns_meter_apply('reserve',r1,digest)<>'DENY_DUPLICATE'
 THEN RAISE EXCEPTION 'late reserve resurrected tombstone'; END IF;
 IF fi_dns_meter_apply('reserve',r2,repeat('a',64))<>'DENY_UNKNOWN'
 THEN RAISE EXCEPTION 'unknown digest accepted'; END IF;
 IF fi_dns_meter_apply('reserve',r2,digest)<>'RESERVED'
 THEN RAISE EXCEPTION 'regional reserve failed'; END IF;
 IF reserve_personal_dns_query(legacy,r3)<>'RESERVED'
 THEN RAISE EXCEPTION 'legacy reserve failed'; END IF;
 IF fi_dns_meter_apply('reserve',r4,digest)<>'DENY_QUOTA'
 THEN RAISE EXCEPTION 'shared limit exceeded'; END IF;
 IF fi_dns_meter_apply('settle',r2)<>'SETTLED'
 OR fi_dns_meter_apply('settle',r2)<>'SETTLED'
 OR fi_dns_meter_apply('release',r2)<>'SETTLED'
 THEN RAISE EXCEPTION 'settlement replay or release incorrect'; END IF;
 IF finish_personal_dns_query(r3,false)<>'RELEASED'
 THEN RAISE EXCEPTION 'legacy release failed'; END IF;
 IF fi_dns_meter_apply('reserve',r4,digest)<>'RESERVED'
 THEN RAISE EXCEPTION 'released budget unavailable'; END IF;
 UPDATE fi_dns_regional_credentials SET revoked_at=clock_timestamp() WHERE entitlement_id=e;
 IF fi_dns_meter_apply('settle',r4)<>'RELEASED'
 OR fi_dns_meter_apply('reserve',r5,digest)<>'DENY_INACTIVE'
 THEN RAISE EXCEPTION 'revoked region allowed'; END IF;
 UPDATE fi_dns_regional_credentials SET revoked_at=NULL,credential_revision=2 WHERE entitlement_id=e;
 IF fi_dns_meter_apply('reserve',r5,digest)<>'RESERVED'
 THEN RAISE EXCEPTION 'new reservation failed'; END IF;
 UPDATE personal_dns_query_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=r5;
 IF reserve_personal_dns_query(legacy,r6)<>'RESERVED'
 THEN RAISE EXCEPTION 'legacy did not recover expired FI hold'; END IF;
 IF fi_dns_meter_apply('settle',r5)<>'RELEASED'
 THEN RAISE EXCEPTION 'expired FI hold settled'; END IF;
 IF finish_personal_dns_query(r6,true)<>'SETTLED'
 THEN RAISE EXCEPTION 'legacy settle failed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM personal_dns_query_windows WHERE entitlement_id=e
  AND period_index=0 AND used_queries=2 AND reserved_queries=0)
 THEN RAISE EXCEPTION 'wrong final shared accounting'; END IF;
 IF has_table_privilege('mnebyvpn_fi_dns_meter','public.fi_dns_regional_credentials','SELECT')
 OR has_table_privilege('mnebyvpn_fi_dns_meter','public.personal_dns_query_windows','UPDATE')
 OR has_function_privilege('mnebyvpn_fi_dns_meter','public.finish_personal_dns_query(uuid,boolean)','EXECUTE')
 OR NOT has_function_privilege('mnebyvpn_fi_dns_meter','public.fi_dns_meter_apply(text,uuid,text)','EXECUTE')
 THEN RAISE EXCEPTION 'meter role not isolated'; END IF;
END $$;
ROLLBACK;
