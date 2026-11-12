-- Offline SQL tests only. The prefix here is a fixture, not real provider allocation.
BEGIN;
DO $$
DECLARE
  aid uuid := 'adadadad-0000-4000-8000-000000000001';
  oid uuid := 'adadadad-0000-4000-8000-000000000002';
  eid uuid;
  v text;
  blocked boolean;
BEGIN
  INSERT INTO accounts(id) VALUES(aid);
  INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
    VALUES(oid,aid,'smart_dns','mock',10000,'RUB');
  SELECT settle_verified_payment(
    oid,'mock','ipv6-gate-event','ipv6-gate-tx',repeat('d',64),
    10000,'RUB',3600,1000
  ) INTO v;
  IF v <> 'APPLIED' THEN RAISE EXCEPTION 'cannot set up entitlement: %',v; END IF;
  SELECT id INTO eid FROM entitlements WHERE source_order_id=oid;

  -- A global-looking IP still isn't usable without verified provider routing.
  SELECT claim_smart_dns_ipv6(eid,'2a03:1111:2222:3333::1'::inet) INTO v;
  IF v <> 'DENY_PREFIX_NOT_VERIFIED' THEN
    RAISE EXCEPTION 'allowed unverified prefix: %',v;
  END IF;

  blocked := false;
  BEGIN
    INSERT INTO smart_dns_routed_prefixes(
      network,approved_for_existing_foreign_vps,
      provider_confirmed_at,public_reachability_verified_at)
    VALUES('2001:db8::/64',true,now(),now());
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'documentation prefix accepted'; END IF;

  INSERT INTO smart_dns_routed_prefixes(
    network,approved_for_existing_foreign_vps,
    provider_confirmed_at,public_reachability_verified_at)
  VALUES('2a03:1111:2222:3333::/64',false,now(),now());

  SELECT claim_smart_dns_ipv6(eid,'2a03:1111:2222:3333::1'::inet) INTO v;
  IF v <> 'DENY_PREFIX_NOT_VERIFIED' THEN
    RAISE EXCEPTION 'allowed unapproved server prefix: %',v;
  END IF;
  UPDATE smart_dns_routed_prefixes SET approved_for_existing_foreign_vps=true
    WHERE network='2a03:1111:2222:3333::/64';
  SELECT claim_smart_dns_ipv6(eid,'2a03:1111:2222:3333::1'::inet) INTO v;
  IF v <> 'BOUND' THEN RAISE EXCEPTION 'verified claim: %',v; END IF;

  blocked := false;
  BEGIN
    DELETE FROM smart_dns_ipv6_claims WHERE entitlement_id=eid;
  EXCEPTION WHEN others THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'permanent claim was deleted'; END IF;

  blocked := false;
  BEGIN
    UPDATE smart_dns_ipv6_claims SET destination_ipv6='2a03:1111:2222:3333::2'
      WHERE entitlement_id=eid;
  EXCEPTION WHEN others THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'permanent IP was rebound'; END IF;

  blocked := false;
  BEGIN
    EXECUTE 'TRUNCATE smart_dns_ipv6_claims';
  EXCEPTION WHEN others THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'permanent claims were truncated'; END IF;

  IF NOT retire_smart_dns_ipv6(eid) THEN
    RAISE EXCEPTION 'normal claim retirement failed';
  END IF;
  blocked := false;
  BEGIN
    UPDATE smart_dns_ipv6_claims SET retired_at=NULL WHERE entitlement_id=eid;
  EXCEPTION WHEN others THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'retired bearer IP was revived'; END IF;

  IF NOT EXISTS(SELECT 1 FROM smart_dns_ipv6_claims
      WHERE entitlement_id=eid
        AND destination_ipv6='2a03:1111:2222:3333::1'
        AND retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'permanent retired claim disappeared';
  END IF;
END $$;
ROLLBACK;
