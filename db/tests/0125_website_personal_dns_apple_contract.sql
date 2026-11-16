-- Production SQL 0125: only a verified paid owner session can receive a bearer.
-- Fixture rollback: does not change plans, subscriptions or real DNS.
BEGIN;
DO $$
DECLARE
  account_a uuid:='12500000-0000-4000-8000-000000000001';
  account_b uuid:='12500000-0000-4000-8000-000000000002';
  order_a uuid:='12500000-0000-4000-8000-000000000003';
  ent_a uuid:='12500000-0000-4000-8000-000000000004';
  session_a text:=repeat('a',64);
  session_b text:=repeat('b',64);
  label_a text:=repeat('x',12);
  label_b text:=repeat('y',12);
  label_c text:=repeat('z',12);
  result text;
  status jsonb;
BEGIN
  INSERT INTO accounts(id) VALUES(account_a),(account_b);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
    VALUES(order_a,account_a,'smart_dns','fixture',20000,'RUB','PAID');
  INSERT INTO entitlements(id,account_id,source_order_id,product,state,
    revision,starts_at,expires_at,quota_limit_bytes)
    VALUES(ent_a,account_a,order_a,'smart_dns','ACTIVE',1,
      clock_timestamp()-interval '1 day',clock_timestamp()+interval '30 days',10000000);
  INSERT INTO website_sessions(token_sha256,account_id,expires_at)
    VALUES(session_a,account_a,clock_timestamp()+interval '1 day'),
          (session_b,account_b,clock_timestamp()+interval '1 day');
  status:=website_personal_dns_status(session_a,ent_a);
  IF status->>'issued'<>'false' OR status->>'revoked'<>'false'
    THEN RAISE EXCEPTION 'pre-issue status is incorrect'; END IF;
  IF website_personal_dns_status(session_b,ent_a) IS NOT NULL
    THEN RAISE EXCEPTION 'cross-account status leaked'; END IF;
  result:=website_issue_personal_dns_credential(session_b,ent_a,label_a,
    encode(sha256(convert_to(label_a,'UTF8')),'hex'));
  IF result<>'DENY_OWNER' THEN RAISE EXCEPTION 'cross-account issue %',result; END IF;
  result:=website_issue_personal_dns_credential(session_a,ent_a,label_a,
    encode(sha256(convert_to(label_a,'UTF8')),'hex'));
  IF result<>'ISSUED' THEN RAISE EXCEPTION 'paid owner issue failed %',result; END IF;
  IF website_personal_dns_status(session_a,ent_a)->>'revision'<>'1'
    THEN RAISE EXCEPTION 'issued revision missing'; END IF;
  result:=website_issue_personal_dns_credential(session_a,ent_a,label_b,
    encode(sha256(convert_to(label_b,'UTF8')),'hex'));
  IF result<>'DENY_ALREADY_ASSIGNED'
    THEN RAISE EXCEPTION 'second bearer issued %',result; END IF;
  result:=website_rotate_personal_dns_credential(session_b,ent_a,1,label_b,
    encode(sha256(convert_to(label_b,'UTF8')),'hex'));
  IF result<>'DENY_OWNER' THEN RAISE EXCEPTION 'foreign rotation %',result; END IF;
  result:=website_rotate_personal_dns_credential(session_a,ent_a,1,label_b,
    encode(sha256(convert_to(label_b,'UTF8')),'hex'));
  IF result<>'ROTATED' THEN RAISE EXCEPTION 'owner rotation %',result; END IF;
  IF recognize_personal_dns_credential(label_a)
    THEN RAISE EXCEPTION 'rotated bearer is still active'; END IF;
  result:=website_rotate_personal_dns_credential(session_a,ent_a,1,label_c,
    encode(sha256(convert_to(label_c,'UTF8')),'hex'));
  IF result<>'DENY_STALE' THEN RAISE EXCEPTION 'stale replay %',result; END IF;
  UPDATE website_sessions SET revoked_at=clock_timestamp()
    WHERE token_sha256=session_a;
  result:=website_rotate_personal_dns_credential(session_a,ent_a,2,label_c,
    encode(sha256(convert_to(label_c,'UTF8')),'hex'));
  IF result<>'DENY_OWNER' THEN RAISE EXCEPTION 'revoked browser session %',result; END IF;
  UPDATE website_sessions SET revoked_at=NULL WHERE token_sha256=session_a;
  UPDATE orders SET state='REFUNDED' WHERE id=order_a;
  IF website_personal_dns_status(session_a,ent_a) IS NOT NULL
    THEN RAISE EXCEPTION 'refunded DNS status exposed'; END IF;
  result:=website_rotate_personal_dns_credential(session_a,ent_a,2,label_c,
    encode(sha256(convert_to(label_c,'UTF8')),'hex'));
  IF result<>'DENY_OWNER' THEN RAISE EXCEPTION 'refunded order allowed profile %',result; END IF;
END $$;
ROLLBACK;
