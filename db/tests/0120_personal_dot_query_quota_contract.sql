-- Rollback-only fixtures: real PostgreSQL checks; no actual DNS traffic.
BEGIN;
DO $$
DECLARE
  a uuid := '12000000-0000-4000-8000-000000000001';
  b uuid := '12000000-0000-4000-8000-000000000002';
  o uuid := '12000000-0000-4000-8000-000000000003';
  e uuid := '12000000-0000-4000-8000-000000000004';
  o2 uuid := '12000000-0000-4000-8000-000000000005';
  e2 uuid := '12000000-0000-4000-8000-000000000006';
  label1 text := 'd'||repeat('a',26);
  label2 text := 'd'||repeat('b',26);
  result text;
  used bigint;
BEGIN
  INSERT INTO accounts(id) VALUES (a),(b);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
    VALUES(o,a,'smart_dns','fixture',20000,'RUB','PAID'),
          (o2,b,'smart_dns','fixture',20000,'RUB','PAID');
  INSERT INTO entitlements(id,account_id,source_order_id,product,state,
       revision,starts_at,expires_at,quota_limit_bytes)
    VALUES
      (e,a,o,'smart_dns','ACTIVE',1,
         clock_timestamp()-interval '1 day',clock_timestamp()+interval '50 days',10000000),
      (e2,b,o2,'smart_dns','ACTIVE',1,
         clock_timestamp()-interval '1 day',clock_timestamp()+interval '50 days',10000000);

  SELECT issue_personal_dns_credential(e,label1,repeat('a',64),3) INTO result;
  IF result<>'ISSUED' THEN RAISE EXCEPTION 'issue failed: %',result; END IF;
  SELECT issue_personal_dns_credential(e,label1,repeat('a',64),3) INTO result;
  IF result<>'ALREADY_ISSUED' THEN RAISE EXCEPTION 'idempotency failed: %',result; END IF;
  SELECT issue_personal_dns_credential(e2,label1,repeat('b',64),3) INTO result;
  IF result<>'DENY_TOKEN_COLLISION' THEN RAISE EXCEPTION 'collision allowed: %',result; END IF;
  SELECT issue_personal_dns_credential(e2,label2,repeat('b',64),3) INTO result;
  IF result<>'ISSUED' THEN RAISE EXCEPTION 'second credential failed: %',result; END IF;
  FOR used IN 1..3 LOOP
    SELECT consume_personal_dns_query(label1) INTO result;
    IF result<>'ALLOWED' THEN RAISE EXCEPTION 'allowed query %: %',used,result; END IF;
  END LOOP;
  SELECT consume_personal_dns_query(label1) INTO result;
  IF result<>'DENY_QUOTA' THEN RAISE EXCEPTION 'over budget: %',result; END IF;
  SELECT used_queries INTO used FROM personal_dns_query_windows
    WHERE entitlement_id=e AND period_index=0;
  IF used<>3 THEN RAISE EXCEPTION 'unexpected counter %',used; END IF;

  -- Existing 30-day bucket never zeroes on paid renewal (expiry extension).
  UPDATE entitlements SET expires_at=expires_at+interval '30 days' WHERE id=e;
  SELECT consume_personal_dns_query(label1) INTO result;
  IF result<>'DENY_QUOTA' THEN RAISE EXCEPTION 'renewal incorrectly reset quota: %',result; END IF;

  -- Next 30-day interval starts an independent bucket; previous history stays.
  UPDATE entitlements SET starts_at=starts_at-interval '31 days' WHERE id=e;
  SELECT consume_personal_dns_query(label1) INTO result;
  IF result<>'ALLOWED' THEN RAISE EXCEPTION 'new period did not reset: %',result; END IF;
  SELECT used_queries INTO used FROM personal_dns_query_windows
    WHERE entitlement_id=e AND period_index=1;
  IF used<>1 THEN RAISE EXCEPTION 'new window used %',used; END IF;
  IF NOT EXISTS(SELECT 1 FROM personal_dns_query_windows
    WHERE entitlement_id=e AND period_index=0 AND used_queries=3)
  THEN RAISE EXCEPTION 'history was erased'; END IF;

  SELECT revoke_personal_dns_credential(e) INTO result;
  IF result::text<>'true' THEN RAISE EXCEPTION 'revoke failed'; END IF;
  SELECT consume_personal_dns_query(label1) INTO result;
  IF result<>'DENY_INACTIVE' THEN RAISE EXCEPTION 'revoked credential accepted: %',result; END IF;

  -- Other subscriber remains independent, and expiry denies requests.
  SELECT consume_personal_dns_query(label2) INTO result;
  IF result<>'ALLOWED' THEN RAISE EXCEPTION 'other user blocked: %',result; END IF;
  UPDATE entitlements SET state='EXPIRED',expires_at=clock_timestamp()-interval '1 second'
    WHERE id=e2;
  SELECT consume_personal_dns_query(label2) INTO result;
  IF result<>'DENY_INACTIVE' THEN RAISE EXCEPTION 'expired still counted: %',result; END IF;
  SELECT consume_personal_dns_query('d'||repeat('c',26)) INTO result;
  IF result<>'DENY_UNKNOWN' THEN RAISE EXCEPTION 'unknown label accepted: %',result; END IF;
  SELECT consume_personal_dns_query('bad_token') INTO result;
  IF result<>'DENY_INVALID' THEN RAISE EXCEPTION 'invalid label accepted: %',result; END IF;
END $$;
ROLLBACK;
