-- Dormant per-slot IPv4 IPAM must coexist with live legacy AWG allocation.
BEGIN;
DO $ipam$
DECLARE
  v_count integer;
  v_pk text;
BEGIN
  IF to_regclass('public.vpn_awg_ipv4_claims') IS NULL THEN
    RAISE EXCEPTION 'Shared IPv4 claims table not created';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_pk FROM pg_constraint
  WHERE conrelid='public.vpn_awg_ipv4_claims'::regclass AND contype='p';
  IF v_pk IS NULL OR v_pk NOT LIKE '%node_id, client_ipv4%' THEN
    RAISE EXCEPTION 'IPv4 conflicts not prevented across owner and legacy peers';
  END IF;
  SELECT count(*) INTO v_count FROM pg_constraint
  WHERE conrelid='public.vpn_awg_ipv4_claims'::regclass AND contype='u';
  IF v_count<>2 THEN
    RAISE EXCEPTION 'Expected peer identity and per-slot uniqueness';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_trigger
    WHERE tgname='vpn_awg_legacy_peer_claim_ipv4'
      AND tgrelid='public.vpn_awg_peer_allocations'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Future legacy grants do not claim shared IP space';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_trigger
    WHERE tgname='vpn_awg_ipv4_claim_immutable'
      AND tgrelid='public.vpn_awg_ipv4_claims'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Address claims could be overwritten or recycled';
  END IF;
  IF EXISTS(
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL
      aclexplode(COALESCE(c.relacl,'{}'::aclitem[])) a
    WHERE c.oid='public.vpn_awg_ipv4_claims'::regclass
      AND a.grantee=0
  ) THEN
    RAISE EXCEPTION 'Shared IPAM leaked to public';
  END IF;
  IF EXISTS(
    SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
      aclexplode(COALESCE(p.proacl,'{}'::aclitem[])) a
    WHERE p.oid='public.owner_vpn_allocate_awg_slot_ipv4(bigint,uuid,smallint,text)'::regprocedure
      AND a.grantee=0
  ) THEN
    RAISE EXCEPTION 'Private owner allocator exposed to PUBLIC';
  END IF;
  IF EXISTS(
    SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_awg_delivery'
  ) AND (
    has_table_privilege('mnebyvpn_awg_delivery',
      'public.vpn_awg_ipv4_claims','INSERT') OR
    has_table_privilege('mnebyvpn_awg_delivery',
      'public.vpn_awg_ipv4_claims','UPDATE') OR
    has_table_privilege('mnebyvpn_awg_delivery',
      'public.vpn_awg_ipv4_claims','DELETE')
  ) THEN
    RAISE EXCEPTION 'Legacy worker must not directly mutate shared claims';
  END IF;
  IF position('FOR UPDATE' IN pg_get_functiondef(
    'public.owner_vpn_allocate_awg_slot_ipv4(bigint,uuid,smallint,text)'::regprocedure
  ))=0 THEN
    RAISE EXCEPTION 'Owner IPAM must serialize node allocation';
  END IF;
  IF position('owner_vpn_reserve_awg_peer_slot' IN pg_get_functiondef(
    'public.owner_vpn_allocate_awg_slot_ipv4(bigint,uuid,smallint,text)'::regprocedure
  ))=0 THEN
    RAISE EXCEPTION 'Owner IPAM must reauthorize paid sale and verified node';
  END IF;
END;
$ipam$;
ROLLBACK;
