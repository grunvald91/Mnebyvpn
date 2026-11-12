-- Only a throwaway PostgreSQL database. No genuine payments or DNS packets.
BEGIN;
DO $$
DECLARE
  aid uuid := 'a0a0a0a0-0000-4000-8000-000000000020';
  paid_order uuid := 'b0b0b0b0-0000-4000-8000-000000000020';
  renew_order uuid := 'b0b0b0b0-0000-4000-8000-000000000021';
  eid uuid := 'c0c0c0c0-0000-4000-8000-000000000020';
  digest text := repeat('a',64);
  outcome text;
  balance record;
BEGIN
  INSERT INTO accounts(id) VALUES(aid);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
    VALUES(paid_order,aid,'smart_dns','mock',20000,'RUB','PAID'),
          (renew_order,aid,'smart_dns','mock',20000,'RUB','PAID');
  INSERT INTO entitlements(
    id,account_id,source_order_id,product,state,revision,
    starts_at,expires_at,quota_limit_bytes
  ) VALUES(eid,aid,paid_order,'smart_dns','ACTIVE',1,
    clock_timestamp(),clock_timestamp()+interval '30 days',1000000);
  SELECT issue_personal_dns_link(eid,digest,1) INTO outcome;
  IF outcome<>'DENY_NO_PAID_CREDIT' THEN
    RAISE EXCEPTION 'Unpaid package received a DNS link: %',outcome;
  END IF;
  INSERT INTO entitlement_credits(
    entitlement_id,order_id,credit_sequence,
    starts_at,ends_at,duration_seconds,quota_bytes
  ) VALUES(eid,paid_order,0,clock_timestamp(),
    clock_timestamp()+interval '30 days',2592000,1000000);

  SELECT issue_personal_dns_link(eid,digest,1) INTO outcome;
  IF outcome<>'ISSUED' THEN RAISE EXCEPTION 'issue failed: %',outcome; END IF;
  SELECT check_personal_dns_link(digest) INTO outcome;
  IF outcome<>'KNOWN_LINK' THEN RAISE EXCEPTION 'valid link was not recognized'; END IF;
  SELECT issue_personal_dns_link(eid,digest,1) INTO outcome;
  IF outcome<>'ALREADY_ISSUED' THEN RAISE EXCEPTION 'not idempotent: %',outcome; END IF;
  SELECT issue_personal_dns_link(eid,repeat('b',64),2) INTO outcome;
  IF outcome<>'DENY_DIFFERENT_CREDENTIAL' THEN
    RAISE EXCEPTION 'accidental reissue: %',outcome;
  END IF;
  SELECT use_personal_dns_proxy_query(repeat('c',64)) INTO outcome;
  IF outcome<>'DENY_UNKNOWN_LINK' THEN RAISE EXCEPTION 'unknown link: %',outcome; END IF;

  SELECT use_personal_dns_proxy_query(digest) INTO outcome;
  IF outcome<>'PROXY_ALLOWED' THEN RAISE EXCEPTION 'first query: %',outcome; END IF;
  SELECT * INTO balance FROM personal_dns_query_balance(eid);
  IF balance.used_queries<>1 OR balance.paid_query_limit<>1000000 OR
     balance.remaining_queries<>999999 THEN
    RAISE EXCEPTION 'balance after first proxy DNS query incorrect';
  END IF;

  -- Simulate a heavily used month: exactly one million accepted queries.
  UPDATE personal_dns_query_usage SET used_queries=999999 WHERE entitlement_id=eid;
  SELECT use_personal_dns_proxy_query(digest) INTO outcome;
  IF outcome<>'PROXY_ALLOWED' THEN RAISE EXCEPTION 'last query: %',outcome; END IF;
  SELECT use_personal_dns_proxy_query(digest) INTO outcome;
  IF outcome<>'DIRECT_QUOTA_EXHAUSTED' THEN
    RAISE EXCEPTION 'over quota allowed: %',outcome;
  END IF;
  SELECT * INTO balance FROM personal_dns_query_balance(eid);
  IF balance.remaining_queries<>0 THEN RAISE EXCEPTION 'exhausted balance wrong'; END IF;

  -- Simulate another VERIFIED paid credit for the same entitlement. The
  -- personal DoT/DoH link is NOT replaced and accumulated usage is preserved.
  INSERT INTO entitlement_credits(
    entitlement_id,order_id,credit_sequence,
    starts_at,ends_at,duration_seconds,quota_bytes
  ) VALUES(eid,renew_order,1,clock_timestamp()+interval '30 days',
    clock_timestamp()+interval '60 days',2592000,1000000);
  SELECT use_personal_dns_proxy_query(digest) INTO outcome;
  IF outcome<>'PROXY_ALLOWED' THEN RAISE EXCEPTION 'paid renewal: %',outcome; END IF;
  SELECT * INTO balance FROM personal_dns_query_balance(eid);
  IF balance.paid_query_limit<>2000000 OR
     balance.used_queries<>1000001 OR balance.remaining_queries<>999999 THEN
    RAISE EXCEPTION 'renewal allowance incorrect';
  END IF;

  UPDATE orders SET state='REFUNDED' WHERE id=renew_order;
  SELECT use_personal_dns_proxy_query(digest) INTO outcome;
  IF outcome<>'DIRECT_QUOTA_EXHAUSTED' THEN
    RAISE EXCEPTION 'refunded credit still usable: %',outcome;
  END IF;
  UPDATE entitlements SET state='REFUNDED',revision=revision+1 WHERE id=eid;
  SELECT use_personal_dns_proxy_query(digest) INTO outcome;
  IF outcome<>'DIRECT_INACTIVE' THEN RAISE EXCEPTION 'revoked link active: %',outcome; END IF;

  UPDATE entitlements SET state='ACTIVE',revision=revision+1,
    starts_at=clock_timestamp()-interval '2 days',
    expires_at=clock_timestamp()-interval '1 day' WHERE id=eid;
  SELECT use_personal_dns_proxy_query(digest) INTO outcome;
  IF outcome<>'DIRECT_INACTIVE' THEN RAISE EXCEPTION 'expired link active: %',outcome; END IF;

  UPDATE personal_dns_links SET disabled_at=clock_timestamp()
    WHERE entitlement_id=eid;
  SELECT use_personal_dns_proxy_query(digest) INTO outcome;
  IF outcome<>'DENY_UNKNOWN_LINK' THEN RAISE EXCEPTION 'disabled credential active'; END IF;
  SELECT check_personal_dns_link(digest) INTO outcome;
  IF outcome<>'DENY_UNKNOWN_LINK' THEN RAISE EXCEPTION 'revoked link still known'; END IF;
END $$;
ROLLBACK;
