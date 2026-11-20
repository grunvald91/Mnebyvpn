-- RU188 is the ONLY VPN entitlement authority. A subscribed customer may
-- access every released node; FI217 is an AWG peer, NOT a new subscription.
-- The native signed worker has SELECT/UPDATE but intentionally lacks INSERT
-- on the device queue. This narrow SECURITY DEFINER gateway enqueues only
-- already-authorized active canonical VPN subscriptions with fresh FI proof.
BEGIN;

CREATE FUNCTION public.awg_controller_enqueue_fi_subscription(
  p_entitlement uuid,p_peer_public_key text,p_revision bigint
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $fi_enroll$
DECLARE v_count integer;
BEGIN
  IF p_entitlement IS NULL OR p_peer_public_key IS NULL
    OR p_peer_public_key !~ '^[A-Za-z0-9+/]{43}=$'
    OR length(decode(p_peer_public_key,'base64'))<>32
    OR decode(p_peer_public_key,'base64')=decode(repeat('00',32),'hex')
    OR p_revision IS NULL OR p_revision<1 OR p_revision>1000000000
  THEN RETURN false; END IF;

  INSERT INTO public.vpn_awg_device_requests(
    entitlement_id,node_id,peer_public_key,billing_revision
  )
  SELECT e.id,'fi-test-01',p_peer_public_key,e.revision
  FROM public.entitlements e
  JOIN public.provisioning_state v
    ON v.entitlement_id=e.id AND v.adapter='vpn'
    AND v.applied_revision=e.revision AND v.last_observed_at IS NOT NULL
  JOIN public.vpn_release_flags f
    ON f.feature='vpn_awg_clients' AND f.enabled=true
  JOIN public.vpn_awg_node_pools p
    ON p.node_id='fi-test-01' AND p.state='verified'
    AND p.endpoint_host='fi.mnebyvpn.site'
    AND p.listen_port=51821
    AND p.subnet_cidr=cidr '10.73.91.0/24'
    AND p.external_e2e_proof_sha256 ~ '^[a-f0-9]{64}$'
    AND p.verified_at>clock_timestamp()-interval '1 hour'
    AND p.verified_at<=clock_timestamp()+interval '30 seconds'
  JOIN public.vpn_node_enrollment_inventory n
    ON n.node_id=p.node_id AND n.status='enrolled'
    AND n.endpoint_host=p.endpoint_host
  WHERE e.id=p_entitlement AND e.revision=p_revision
    AND e.product='vpn' AND e.state='ACTIVE'
    AND e.expires_at>clock_timestamp()
    AND NOT EXISTS(
      SELECT 1 FROM public.vpn_awg_peer_allocations a
      WHERE a.entitlement_id=e.id AND a.node_id='fi-test-01'
    )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count NOT IN (0,1) THEN
    RAISE EXCEPTION 'unexpected FI subscriber enrollment cardinality';
  END IF;
  RETURN v_count=1;
END;
$fi_enroll$;

REVOKE ALL ON FUNCTION
  public.awg_controller_enqueue_fi_subscription(uuid,text,bigint)
  FROM PUBLIC;
-- Do not give direct INSERT to the worker or the public website.
DO $fi_role$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles
            WHERE rolname='mnebyvpn_awg_delivery') THEN
    GRANT EXECUTE ON FUNCTION
      public.awg_controller_enqueue_fi_subscription(uuid,text,bigint)
      TO mnebyvpn_awg_delivery;
  END IF;
END;
$fi_role$;
COMMIT;
