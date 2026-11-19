-- Dedicated AWG worker safe row-lock gateway.
-- PostgreSQL requires UPDATE privilege for SELECT ... FOR SHARE.
-- The worker MUST NOT gain UPDATE privileges on billing, inventory or
-- verified-node pools. These bounded SECURITY DEFINER functions lock only
-- one exact entitlement or node row and return only existing review fields.
-- They execute in the caller's current transaction, retaining locks until
-- COMMIT/ROLLBACK without any round trip in the VPN data plane.
BEGIN;

DROP FUNCTION IF EXISTS public.awg_worker_lock_entitlement(uuid);
CREATE FUNCTION public.awg_worker_lock_entitlement(p_entitlement uuid)
RETURNS TABLE (
  id uuid, product text, state text, revision bigint, expires_at timestamptz
)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT e.id,e.product,e.state,e.revision,e.expires_at
    FROM public.entitlements AS e WHERE e.id=p_entitlement FOR SHARE;
$$;

DROP FUNCTION IF EXISTS public.awg_worker_lock_node(text);
CREATE FUNCTION public.awg_worker_lock_node(p_node text)
RETURNS TABLE (
  endpoint_host text,status text,identity_public_spki text
)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i.endpoint_host,i.status,i.identity_public_spki
    FROM public.vpn_node_enrollment_inventory AS i
    WHERE i.node_id=p_node AND p_node='fi-test-01' FOR SHARE;
$$;

DROP FUNCTION IF EXISTS public.awg_worker_lock_pool(text);
CREATE FUNCTION public.awg_worker_lock_pool(p_node text)
RETURNS TABLE (
  node_id text,endpoint_host text,state text,subnet_cidr text,
  verified_at timestamptz,server_public_key text
)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.node_id,p.endpoint_host,p.state,p.subnet_cidr::text,
         p.verified_at,p.server_public_key
    FROM public.vpn_awg_node_pools AS p
    WHERE p.node_id=p_node AND p_node='fi-test-01' FOR SHARE;
$$;

DROP FUNCTION IF EXISTS public.awg_worker_lock_pool_node(text);
CREATE FUNCTION public.awg_worker_lock_pool_node(p_node text)
RETURNS TABLE (
  state text,verified_at timestamptz,endpoint_host text,status text
)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.state,p.verified_at,p.endpoint_host,i.status
    FROM public.vpn_awg_node_pools AS p
    JOIN public.vpn_node_enrollment_inventory AS i ON i.node_id=p.node_id
    WHERE p.node_id=p_node AND p_node='fi-test-01'
    FOR SHARE OF p,i;
$$;

REVOKE ALL ON FUNCTION public.awg_worker_lock_entitlement(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.awg_worker_lock_node(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.awg_worker_lock_pool(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.awg_worker_lock_pool_node(text) FROM PUBLIC;

-- Some deployments do not yet have the FI-only scoped worker role. Preserve
-- migration portability: it must not create the role or broaden grants.
DO $gateway$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles
            WHERE rolname='mnebyvpn_awg_delivery') THEN
    GRANT EXECUTE ON FUNCTION public.awg_worker_lock_entitlement(uuid),
                              public.awg_worker_lock_node(text),
                              public.awg_worker_lock_pool(text),
                              public.awg_worker_lock_pool_node(text)
      TO mnebyvpn_awg_delivery;
  END IF;
END;
$gateway$;
COMMIT;
