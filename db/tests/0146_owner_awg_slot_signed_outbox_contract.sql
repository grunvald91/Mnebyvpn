-- No V2 peer can reach a node merely because the SQL outbox exists.
BEGIN;
DO $check$
DECLARE v_n integer;
BEGIN
  IF to_regclass('public.owner_vpn_awg_slot_allocations') IS NULL OR
     to_regclass('public.owner_vpn_awg_slot_command_outbox') IS NULL THEN
    RAISE EXCEPTION 'V2 per-device allocation/outbox schema missing';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.vpn_release_flags
    WHERE feature='owner_awg_slot_v2' AND enabled=false
  ) THEN RAISE EXCEPTION 'AWG V2 owner feature must stay OFF after migration'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.owner_vpn_awg_slot_allocations'::regclass
    AND c.contype='p'
    AND pg_get_constraintdef(c.oid) LIKE '%node_id, entitlement_id, slot_number%'
  ) THEN RAISE EXCEPTION 'V2 allocation is not per-slot keyed'; END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
    WHERE conrelid='public.owner_vpn_awg_slot_allocations'::regclass
    AND contype='f' AND confrelid IN (
      'public.vpn_awg_ipv4_claims'::regclass,
      'public.owner_vpn_awg_peer_reservations'::regclass);
  IF v_n<>2 THEN RAISE EXCEPTION 'V2 slot source claims not bound to original IPAM and reservation'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.owner_vpn_awg_slot_command_outbox'::regclass
    AND c.contype='u'
    AND pg_get_constraintdef(c.oid) LIKE
      '%node_id, entitlement_id, slot_number, revision%'
  ) THEN RAISE EXCEPTION 'Signed slot revision uniqueness missing'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.owner_vpn_awg_slot_allocations'::regclass
      AND tgname='owner_vpn_awg_slot_allocation_guard' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'Immutable slot trigger missing'; END IF;
  IF EXISTS(
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL
      aclexplode(coalesce(c.relacl,'{}'::aclitem[])) a
    WHERE c.oid IN (
      'public.owner_vpn_awg_slot_allocations'::regclass,
      'public.owner_vpn_awg_slot_command_outbox'::regclass)
    AND a.grantee=0
  ) THEN RAISE EXCEPTION 'V2 slots exposed to PUBLIC'; END IF;
  IF EXISTS(
    SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_bot'
  ) AND (
    has_table_privilege('mnebyvpn_bot','public.owner_vpn_awg_slot_allocations','INSERT')
    OR has_table_privilege('mnebyvpn_bot','public.owner_vpn_awg_slot_allocations','UPDATE')
    OR has_table_privilege('mnebyvpn_bot','public.owner_vpn_awg_slot_command_outbox','INSERT')
  ) THEN RAISE EXCEPTION 'Bot must not directly fabricate applied V2 nodes'; END IF;
  IF EXISTS(
    SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_awg_delivery'
  ) AND (
    has_table_privilege('mnebyvpn_awg_delivery','public.owner_vpn_awg_slot_allocations','INSERT')
    OR has_table_privilege('mnebyvpn_awg_delivery','public.owner_vpn_awg_slot_command_outbox','UPDATE')
  ) THEN RAISE EXCEPTION 'V1 worker must not mutate V2 queue'; END IF;
  IF EXISTS(
    SELECT 1 FROM pg_class WHERE oid='public.vpn_awg_command_outbox'::regclass
      AND relname<>'vpn_awg_command_outbox'
  ) THEN RAISE EXCEPTION 'Legacy outbox modified'; END IF;
END;
$check$;
ROLLBACK;
