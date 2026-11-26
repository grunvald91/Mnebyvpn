-- Trial bundle shares a fixed three concurrent VPN connections across DE/FI.
-- No fake paid order/terms or changes to node identities, gate, or paid caps.
-- Only an independently activated canonical 24h bundle may use this policy.
BEGIN;
CREATE OR REPLACE FUNCTION public.vpn_shared_connection_claim(
 p_entitlement_id uuid,p_connection_id uuid,p_node_id text,p_peer_sha256 text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $claim$
DECLARE
 v_time timestamptz;
 v_expiry timestamptz;
 v_revision bigint;
 v_cap smallint;
 v_count integer;
 v_previous public.vpn_shared_connection_leases%ROWTYPE;
BEGIN
 IF p_entitlement_id IS NULL OR p_connection_id IS NULL OR p_node_id IS NULL
    OR p_peer_sha256 IS NULL OR p_peer_sha256 !~ '^[a-f0-9]{64}$' THEN
   RETURN 'DENY_INVALID';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.vpn_release_flags
   WHERE feature='vpn_shared_connection_admission' AND enabled=true) THEN
   RETURN 'DENY_DISABLED';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.vpn_shared_connection_nodes
   WHERE node_id=p_node_id AND enabled=true) THEN
   RETURN 'DENY_NODE';
 END IF;
 -- Single serialization point across BOTH nodes; no per-region counter.
 PERFORM 1 FROM public.entitlements WHERE id=p_entitlement_id FOR UPDATE;
 IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
 v_time:=clock_timestamp();
 SELECT e.revision,e.expires_at,
   CASE WHEN o.state='PAID' THEN t.device_limit ELSE 3 END
 INTO v_revision,v_expiry,v_cap
 FROM public.entitlements e
 JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
 LEFT JOIN public.order_terms t ON t.order_id=o.id
 JOIN public.provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn'
 WHERE e.id=p_entitlement_id AND e.product='vpn' AND e.state='ACTIVE'
   AND e.expires_at>v_time
   AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL
   AND (
     (o.state='PAID' AND t.device_limit BETWEEN 1 AND 16)
     OR (
       o.state='TRIAL' AND o.provider='internal_trial' AND o.amount_minor=0
       AND o.product='bundle' AND e.starts_at<=v_time
       AND EXISTS (
         SELECT 1 FROM public.trial_grants g
         WHERE g.order_id=o.id AND g.account_id=e.account_id AND g.product='bundle'
           AND g.activated_at=e.starts_at AND g.access_expires_at=e.expires_at
           AND g.access_expires_at=g.activated_at+interval '24 hours'
       )
     )
   );
 IF NOT FOUND THEN RETURN 'DENY_ENTITLEMENT'; END IF;
 SELECT * INTO v_previous FROM public.vpn_shared_connection_leases
  WHERE entitlement_id=p_entitlement_id AND connection_id=p_connection_id;
 IF FOUND THEN
   IF v_previous.state<>'ACTIVE' OR v_previous.lease_until<=v_time
      OR v_previous.entitlement_revision<>v_revision
      OR v_previous.node_id<>p_node_id
      OR v_previous.peer_sha256<>p_peer_sha256 THEN
     RETURN 'DENY_REPLAY';
   END IF;
   UPDATE public.vpn_shared_connection_leases SET
     last_heartbeat_at=v_time,
     lease_until=LEAST(v_expiry,v_time+interval '45 seconds')
    WHERE entitlement_id=p_entitlement_id AND connection_id=p_connection_id;
   RETURN 'REFRESHED';
 END IF;
 SELECT count(*) INTO v_count FROM public.vpn_shared_connection_leases
 WHERE entitlement_id=p_entitlement_id AND state='ACTIVE' AND lease_until>v_time;
 IF v_count>=v_cap THEN RETURN 'DENY_LIMIT'; END IF;
 INSERT INTO public.vpn_shared_connection_leases(
  entitlement_id,connection_id,node_id,peer_sha256,entitlement_revision,
  state,admitted_at,last_heartbeat_at,lease_until
 ) VALUES(p_entitlement_id,p_connection_id,p_node_id,p_peer_sha256,v_revision,
  'ACTIVE',v_time,v_time,LEAST(v_expiry,v_time+interval '45 seconds'));
 RETURN 'ADMITTED';
END $claim$;
-- Keep V1 internal to the signed V2 gateway (0148). No new privileges.
REVOKE ALL ON FUNCTION public.vpn_shared_connection_claim(uuid,uuid,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.vpn_shared_connection_claim(uuid,uuid,text,text) FROM mnebyvpn_connection_admission;
COMMIT;
