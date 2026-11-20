-- FI217: fix the AWG allocation trigger's internal pool row lock.
-- The dedicated RU188 worker has SELECT on the verified node pool but
-- MUST NOT receive UPDATE there. PostgreSQL SELECT ... FOR SHARE inside
-- this legacy trigger requires a row-lock privilege unavailable to that
-- worker, causing every signed grant stage to retry.
--
-- Keep the FOR SHARE concurrency check. The EXISTING private trigger is
-- executed with its canonical schema owner's privileges, not with extra
-- UPDATE grants given to a client delivery role.
BEGIN;

DO $fi_owner$
DECLARE
  actual_owner text;
  pool_owner text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(p.proowner) INTO actual_owner
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='vpn_awg_enforce_address_pool'
    AND p.pronargs=0
    AND p.prorettype='pg_catalog.trigger'::pg_catalog.regtype;
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO pool_owner
  FROM pg_catalog.pg_class c
  WHERE c.oid='public.vpn_awg_node_pools'::pg_catalog.regclass;
  IF actual_owner IS DISTINCT FROM current_user
     OR pool_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'Unapproved FI trigger or verified pool owner';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgname='vpn_awg_address_immutability'
      AND t.tgrelid='public.vpn_awg_peer_allocations'::pg_catalog.regclass
      AND t.tgfoid='public.vpn_awg_enforce_address_pool()'::pg_catalog.regprocedure
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Expected FI peer address validation trigger missing';
  END IF;
END;
$fi_owner$;

ALTER FUNCTION public.vpn_awg_enforce_address_pool()
  SECURITY DEFINER;
ALTER FUNCTION public.vpn_awg_enforce_address_pool()
  SET search_path = pg_catalog, public;

-- Never grant EXECUTE to PUBLIC or direct pool UPDATE to AWG delivery.
REVOKE ALL ON FUNCTION public.vpn_awg_enforce_address_pool() FROM PUBLIC;

DO $fi_confirm$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='vpn_awg_enforce_address_pool'
      AND p.pronargs=0 AND p.prosecdef=true
      AND 'search_path=pg_catalog, public'=ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'FI signed peer trigger lock privilege was not repaired';
  END IF;
END;
$fi_confirm$;
COMMIT;
