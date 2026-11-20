-- Production SQL 0140: 24h Smart DNS trials issue Personal DoT/Apple profiles
-- while active and strictly stop resolving Smart DNS after 24h expiry.
-- Fixture rollback: does not mutate live customer data.
BEGIN;
DO $$
DECLARE
  account_t uuid:='14000000-0000-4000-8000-000000000001';
  order_t uuid:='14000000-0000-4000-8000-000000000002';
  ent_t uuid:='14000000-0000-4000-8000-000000000003';
  session_t text:=repeat('c',64);
  label_1 text:='t140dnsoneaa';
  label_2 text:='t140dnstwobb';
  hash_1 text:=encode(sha256(convert_to(label_1,'UTF8')),'hex');
  hash_2 text:=encode(sha256(convert_to(label_2,'UTF8')),'hex');
  req_id uuid:='14000000-0000-4000-8000-000000000004';
  status jsonb;
  res text;
  expired_count integer;
BEGIN
  INSERT INTO accounts(id) VALUES(account_t);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
    VALUES(order_t,account_t,'smart_dns','internal_trial',0,'XTR','TRIAL');
  INSERT INTO entitlements(id,account_id,source_order_id,product,state,
    revision,starts_at,expires_at,quota_limit_bytes)
    VALUES(ent_t,account_t,order_t,'smart_dns','ACTIVE',1,
      clock_timestamp(),clock_timestamp()+interval '24 hours',1073741824);
  INSERT INTO website_sessions(token_sha256,account_id,expires_at)
    VALUES(session_t,account_t,clock_timestamp()+interval '12 hours');

  status:=website_personal_dns_status(session_t,ent_t);
  IF status IS NULL OR status->>'issued'<>'false' THEN
    RAISE EXCEPTION 'trial DNS status unavailable: %', status;
  END IF;

  res:=website_issue_personal_dns_credential(session_t,ent_t,label_1,hash_1);
  IF res<>'ISSUED' THEN
    RAISE EXCEPTION 'trial DNS issue failed: %', res;
  END IF;

  res:=reserve_personal_dns_query(label_1,req_id);
  IF res<>'RESERVED' THEN
    RAISE EXCEPTION 'active 24h trial DNS query failed: %', res;
  END IF;
  PERFORM finish_personal_dns_query(req_id,true);

  -- Simulate 24h elapsed: queries and profile issuance/rotation must deny immediately.
  UPDATE entitlements
    SET starts_at=clock_timestamp()-interval '25 hours',
        expires_at=clock_timestamp()-interval '1 minute'
    WHERE id=ent_t;

  res:=reserve_personal_dns_query(label_1,'14000000-0000-4000-8000-000000000005');
  IF res<>'DENY_INACTIVE' THEN
    RAISE EXCEPTION 'expired 24h trial DNS still reserved: %', res;
  END IF;

  IF website_personal_dns_status(session_t,ent_t) IS NOT NULL THEN
    RAISE EXCEPTION 'expired trial DNS status remained visible';
  END IF;

  res:=website_rotate_personal_dns_credential(session_t,ent_t,1,label_2,hash_2);
  IF res<>'DENY_OWNER' THEN
    RAISE EXCEPTION 'expired trial DNS rotation allowed: %', res;
  END IF;

  expired_count:=expire_due_entitlements();
  IF expired_count<1 THEN
    RAISE EXCEPTION 'expire_due_entitlements did not mark expired trial';
  END IF;
  IF (SELECT state FROM entitlements WHERE id=ent_t)<>'EXPIRED' THEN
    RAISE EXCEPTION 'entitlement state did not become EXPIRED';
  END IF;
END $$;
ROLLBACK;
