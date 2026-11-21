-- Non-live multi-peer owner reservation schema and privilege regression.
BEGIN;
DO $contract$
DECLARE v_pk text;
BEGIN
  IF to_regclass('public.owner_vpn_awg_peer_reservations') IS NULL THEN
    RAISE EXCEPTION 'Missing private owner multi-peer reservation registry';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_pk
  FROM pg_constraint
  WHERE conrelid='public.owner_vpn_awg_peer_reservations'::regclass
    AND contype='p';
  IF v_pk IS NULL
     OR v_pk NOT LIKE '%node_id, entitlement_id, slot_number%' THEN
    RAISE EXCEPTION 'Private AWG registry must identify each independent slot: %',v_pk;
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.owner_vpn_awg_peer_reservations'::regclass
      AND contype='f'
      AND confrelid='public.owner_vpn_device_seats'::regclass
  ) THEN
    RAISE EXCEPTION 'Private AWG reservations not bounded by 3 registered slots';
  END IF;
  IF EXISTS(
    SELECT 1 FROM pg_attribute
    WHERE attrelid='public.owner_vpn_awg_peer_reservations'::regclass
      AND attnum>0 AND NOT attisdropped
      AND attname IN ('client_ipv4','private_key','node_receipt_sha256','signed_command')
  ) THEN
    RAISE EXCEPTION 'Reservations must never claim allocated IPs, private keys or ACK';
  END IF;
  IF EXISTS(
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL
      aclexplode(COALESCE(c.relacl,'{}'::aclitem[])) p
    WHERE c.oid='public.owner_vpn_awg_peer_reservations'::regclass
      AND p.grantee=0
  ) THEN
    RAISE EXCEPTION 'Private reservation data leaked to PUBLIC';
  END IF;
  IF EXISTS(
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,'{}'::aclitem[])) a
    WHERE n.nspname='public' AND p.proname='owner_vpn_reserve_awg_peer_slot'
      AND a.grantee=0
  ) THEN
    RAISE EXCEPTION 'Private owner reservation function leaked to PUBLIC';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_awg_delivery') THEN
    IF has_table_privilege('mnebyvpn_awg_delivery',
       'public.owner_vpn_awg_peer_reservations','INSERT') OR
       has_table_privilege('mnebyvpn_awg_delivery',
       'public.owner_vpn_awg_peer_reservations','UPDATE') THEN
      RAISE EXCEPTION 'Legacy worker must not write new per-slot peer registry';
    END IF;
  END IF;
END;
$contract$;
ROLLBACK;
