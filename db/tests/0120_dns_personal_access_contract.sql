-- Full paid DNS time-only credential lifecycle in disposable PostgreSQL.
-- This test must roll back all fixtures. NO traffic quota or proxy byte claims.
BEGIN;

DO $test120$
DECLARE
  a uuid:='c1200000-0000-4000-8000-000000000001';
  b uuid:='c1200000-0000-4000-8000-000000000002';
  o uuid:='c1200000-0000-4000-8000-000000000003';
  ent uuid;
  v text;
  total numeric;
  state text;
  usage_day date;
BEGIN
  INSERT INTO accounts(id) VALUES(a),(b);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
  VALUES(o,a,'smart_dns','mock',2000,'RUB');

  -- Neither an unverified checkout nor another account can mint a link.
  SELECT dns_issue_link_for_account(a,o,repeat('a',64),false) INTO v;
  IF v<>'DENY_ACCOUNT' THEN RAISE EXCEPTION 'unpaid account id minted %',v; END IF;

  SELECT settle_verified_payment(o,'mock','p120','capture120',repeat('c',64),
                                 2000,'RUB',86400,2048) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'verified purchase not applied %',v; END IF;
  SELECT id INTO ent FROM entitlements WHERE source_order_id=o;
  SELECT dns_issue_link_for_account(a,ent,repeat('a',64),false) INTO v;
  IF v<>'DENY_INACTIVE' THEN RAISE EXCEPTION 'unprovisioned order minted %',v; END IF;

  UPDATE entitlements SET state='ACTIVE' WHERE id=ent;
  SELECT dns_issue_link_for_account(a,ent,repeat('a',64),false) INTO v;
  IF v<>'DENY_NOT_PROVISIONED' THEN
    RAISE EXCEPTION 'unacknowledged DNS minted %',v; END IF;
  INSERT INTO provisioning_state(
    entitlement_id,adapter,applied_revision,last_observed_at)
    SELECT id,'smart_dns',revision,clock_timestamp()
    FROM entitlements WHERE id=ent;

  SELECT dns_issue_link_for_account(b,ent,repeat('a',64),false) INTO v;
  IF v<>'DENY_ACCOUNT' THEN RAISE EXCEPTION 'another account issued %',v; END IF;
  SELECT dns_issue_link_for_account(a,ent,repeat('a',64),false) INTO v;
  IF v<>'ISSUED' THEN RAISE EXCEPTION 'paid DNS link not issued %',v; END IF;
  SELECT dns_issue_link_for_account(a,ent,repeat('b',64),false) INTO v;
  IF v<>'ALREADY_ISSUED' THEN RAISE EXCEPTION 'non-rotating duplicate link %',v; END IF;
  IF (SELECT count(*) FROM dns_subscription_links
      WHERE entitlement_id=ent AND revoked_at IS NULL)<>1 THEN
    RAISE EXCEPTION 'duplicate live tokens allowed'; END IF;

  SELECT dns_authorize_and_count_query(repeat('b',64)) INTO v;
  IF v<>'DENY' THEN RAISE EXCEPTION 'forged token accepted'; END IF;
  SELECT dns_authorize_and_count_query(repeat('a',64)) INTO v;
  IF v<>'AUTHORIZED' THEN RAISE EXCEPTION 'valid DNS request denied %',v; END IF;
  SELECT dns_authorize_and_count_query(repeat('a',64)) INTO v;
  IF v<>'AUTHORIZED' THEN RAISE EXCEPTION 'repeat paid DNS request denied %',v; END IF;
  SELECT authorized_queries,utc_day INTO total,usage_day
    FROM dns_subscription_daily_usage u
    JOIN dns_subscription_links l ON u.link_id=l.id
    WHERE l.token_sha256=repeat('a',64);
  IF total<>2 OR usage_day<>(clock_timestamp() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'aggregate per-day usage incorrect: %',total; END IF;

  SELECT access_state,authorized_queries INTO state,total
    FROM dns_links_for_account(a) WHERE entitlement_id=ent;
  IF state<>'ACTIVE' OR total<>2 THEN
    RAISE EXCEPTION 'account dashboard missing query aggregate'; END IF;
  IF EXISTS(SELECT 1 FROM dns_links_for_account(b)) THEN
    RAISE EXCEPTION 'cross-account dashboard data visible'; END IF;

  -- Rotation irreversibly revokes the previous hostname without changing
  -- the underlying paid entitlement or losing historical counters.
  SELECT dns_issue_link_for_account(a,ent,repeat('d',64),true) INTO v;
  IF v<>'ROTATED' THEN RAISE EXCEPTION 'rotation failed: %',v; END IF;
  SELECT dns_authorize_and_count_query(repeat('a',64)) INTO v;
  IF v<>'DENY' THEN RAISE EXCEPTION 'old DNS hostname still valid'; END IF;
  SELECT dns_authorize_and_count_query(repeat('d',64)) INTO v;
  IF v<>'AUTHORIZED' THEN RAISE EXCEPTION 'new DNS hostname denied'; END IF;
  SELECT authorized_queries INTO total FROM dns_links_for_account(a)
    WHERE entitlement_id=ent;
  IF total<>1 THEN RAISE EXCEPTION 'active link daily count not isolated'; END IF;

  SELECT dns_revoke_link_for_account(b,ent) INTO v;
  IF v<>'DENY_ACCOUNT' THEN RAISE EXCEPTION 'cross-account revoke allowed'; END IF;
  SELECT dns_revoke_link_for_account(a,ent) INTO v;
  IF v<>'REVOKED' THEN RAISE EXCEPTION 'revocation failed %',v; END IF;
  SELECT dns_authorize_and_count_query(repeat('d',64)) INTO v;
  IF v<>'DENY' THEN RAISE EXCEPTION 'revoked hostname authorized'; END IF;
  SELECT dns_revoke_link_for_account(a,ent) INTO v;
  IF v<>'ALREADY_REVOKED' THEN RAISE EXCEPTION 'duplicate revoke wrong %',v; END IF;

  SELECT dns_issue_link_for_account(a,ent,repeat('e',64),false) INTO v;
  IF v<>'ISSUED' THEN RAISE EXCEPTION 'new issue after revoke failed %',v; END IF;
  SELECT apply_verified_refund(o,'mock','r120','capture120',repeat('f',64)) INTO v;
  IF v<>'APPLIED' THEN RAISE EXCEPTION 'verified refund not applied %',v; END IF;
  SELECT dns_authorize_and_count_query(repeat('e',64)) INTO v;
  IF v<>'DENY' THEN RAISE EXCEPTION 'refunded DNS credential continued serving'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM dns_subscription_links
      WHERE entitlement_id=ent AND token_sha256=repeat('e',64)
        AND revoked_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'refund did not permanently revoke token'; END IF;
  SELECT dns_issue_link_for_account(a,ent,repeat('1',64),false) INTO v;
  IF v NOT IN ('DENY_INACTIVE','DENY_NOT_PAID') THEN
    RAISE EXCEPTION 'refunded order minted a new DNS credential %',v; END IF;

  -- Even a mistaken activation cannot reawaken a manually or refund-revoked
  -- credential because old hashes are never reused or set to NULL.
  UPDATE entitlements SET state='ACTIVE' WHERE id=ent;
  SELECT dns_authorize_and_count_query(repeat('e',64)) INTO v;
  IF v<>'DENY' THEN RAISE EXCEPTION 'refunded token came back to life'; END IF;
END
$test120$;

DO $priv120$
BEGIN
  IF has_table_privilege('mnebyvpn_dns_resolver','public.entitlements','SELECT')
     OR has_table_privilege('mnebyvpn_dns_resolver','public.dns_subscription_links','SELECT')
     OR has_table_privilege('mnebyvpn_dns_resolver','public.dns_subscription_daily_usage','UPDATE')
     OR NOT has_function_privilege('mnebyvpn_dns_resolver',
       'public.dns_authorize_and_count_query(text)','EXECUTE')
     OR has_function_privilege('mnebyvpn_dns_resolver',
       'public.dns_issue_link_for_account(uuid,uuid,text,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'DNS resolver DB role too broad or missing'; END IF;
END
$priv120$;

SET LOCAL ROLE mnebyvpn_dns_resolver;
SELECT dns_authorize_and_count_query(repeat('9',64));
RESET ROLE;
ROLLBACK;
