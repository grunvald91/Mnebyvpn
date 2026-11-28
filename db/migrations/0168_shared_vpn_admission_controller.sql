-- Private signed controller gateway database boundary. No live enablement.
BEGIN;
CREATE OR REPLACE FUNCTION public.vpn_shared_connection_verified_apply(
 p_entitlement uuid,p_connection uuid,p_node text,p_peer_sha256 text,
 p_operation text,p_nonce text,p_request_sha256 text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $apply$
DECLARE
 v_now timestamptz;
 v_rows int;
BEGIN
 IF p_entitlement IS NULL OR p_connection IS NULL OR p_node IS NULL
 OR p_peer_sha256 IS NULL OR p_peer_sha256 !~ '^[a-f0-9]{64}$'
 OR p_peer_sha256=repeat('0',64)
 OR p_operation IS NULL OR p_operation NOT IN ('claim','refresh','release')
 OR p_nonce IS NULL OR p_nonce !~ '^[a-f0-9]{64}$' OR p_nonce=repeat('0',64)
 OR p_request_sha256 IS NULL OR p_request_sha256 !~ '^[a-f0-9]{64}$'
 OR p_request_sha256=repeat('0',64) THEN RETURN 'DENY_INVALID'; END IF;

 IF p_operation<>'release' AND NOT EXISTS (
   SELECT 1 FROM public.vpn_release_flags
   WHERE feature='vpn_shared_connection_admission' AND enabled=true
 ) THEN RETURN 'DENY_DISABLED'; END IF;

 IF NOT EXISTS (
   SELECT 1 FROM public.vpn_shared_connection_nodes n
   JOIN public.vpn_node_enrollment_inventory i ON i.node_id=n.node_id
   WHERE n.node_id=p_node AND n.enabled=true AND i.status='enrolled'
 ) THEN RETURN 'DENY_NODE'; END IF;

 -- This is only the DB half of an authenticated request. The caller must
 -- first verify exact Ed25519 node pin, signed fields and timestamp.
 INSERT INTO public.vpn_shared_connection_nonces(
  node_id,nonce,request_sha256) VALUES(p_node,p_nonce,p_request_sha256)
 ON CONFLICT(node_id,nonce) DO NOTHING;
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 IF v_rows<>1 THEN RETURN 'DENY_REPLAY'; END IF;

 -- Same lock as old 0147 claim ensures global DE+FI serializability.
 PERFORM 1 FROM public.entitlements WHERE id=p_entitlement FOR UPDATE;
 IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
 v_now:=clock_timestamp();

 IF p_operation<>'release' AND NOT EXISTS(
   SELECT 1 FROM public.vpn_shared_connection_authorized_peers b
   JOIN public.entitlements e ON e.id=b.entitlement_id
   WHERE b.entitlement_id=p_entitlement AND b.node_id=p_node
    AND b.peer_sha256=p_peer_sha256 AND b.state='ACTIVE'
    AND b.entitlement_revision=e.revision AND b.grant_expires_at>v_now
 ) THEN RETURN 'DENY_PEER'; END IF;

 -- A new claim cannot act as a heartbeat, even with a new nonce.
 IF p_operation='claim' AND EXISTS(
   SELECT 1 FROM public.vpn_shared_connection_leases
   WHERE entitlement_id=p_entitlement AND connection_id=p_connection
 ) THEN RETURN 'DENY_REPLAY'; END IF;

 -- Heartbeats must never allocate a new connection.
 IF p_operation='refresh' AND NOT EXISTS(
   SELECT 1 FROM public.vpn_shared_connection_leases
   WHERE entitlement_id=p_entitlement AND connection_id=p_connection
     AND node_id=p_node AND peer_sha256=p_peer_sha256
     AND state='ACTIVE' AND lease_until>v_now
 ) THEN RETURN 'DENY_REPLAY'; END IF;

 IF p_operation='release' THEN
   RETURN public.vpn_shared_connection_release(
     p_entitlement,p_connection,p_node,p_peer_sha256);
 END IF;
 RETURN public.vpn_shared_connection_claim(
   p_entitlement,p_connection,p_node,p_peer_sha256);
END $apply$;


CREATE FUNCTION public.vpn_shared_admission_node_identity(p_node text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('nodeId',n.node_id,'countryCode',n.country_code,
   'identityPublicSpki',i.identity_public_spki,'identityPublicSha256',n.node_public_key_sha256)
 FROM public.vpn_shared_connection_nodes n
 JOIN public.vpn_node_enrollment_inventory i ON i.node_id=n.node_id
 WHERE n.node_id=p_node AND n.enabled AND i.status='enrolled'
$$;
-- Return the actual committed ledger deadline, never manufacture a lease
-- in the network worker. The caller must verify the Ed25519 envelope first.
CREATE FUNCTION public.vpn_shared_admission_decide(
 p_entitlement uuid,p_connection uuid,p_node text,p_peer text,p_operation text,
 p_nonce text,p_request_sha text,p_country text,p_pin text,p_issued_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r text; until_at timestamptz; at_time timestamptz;
BEGIN
 IF p_issued_at IS NULL OR abs(extract(epoch FROM(clock_timestamp()-p_issued_at)))>15
 THEN RETURN jsonb_build_object('result','DENY_REPLAY','leaseUntil',NULL); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.vpn_shared_connection_nodes n
 JOIN public.vpn_node_enrollment_inventory i ON i.node_id=n.node_id
 WHERE n.node_id=p_node AND n.country_code=p_country AND n.node_public_key_sha256=p_pin
 AND n.enabled AND i.status='enrolled')
 THEN RETURN jsonb_build_object('result','DENY_NODE','leaseUntil',NULL); END IF;
 r:=public.vpn_shared_connection_verified_apply(p_entitlement,p_connection,p_node,p_peer,p_operation,p_nonce,p_request_sha);
 IF r IN ('ADMITTED','REFRESHED') THEN
   -- verified_apply holds the entitlement lock until this transaction ends.
   -- Clamp to the authorized peer's independent grant deadline as well.
   UPDATE public.vpn_shared_connection_leases l
    SET lease_until=LEAST(l.lease_until,b.grant_expires_at)
   FROM public.vpn_shared_connection_authorized_peers b
   WHERE l.entitlement_id=p_entitlement AND l.connection_id=p_connection
     AND l.node_id=p_node AND l.peer_sha256=p_peer AND l.state='ACTIVE'
     AND b.entitlement_id=l.entitlement_id AND b.node_id=l.node_id
     AND b.peer_sha256=l.peer_sha256 AND b.state='ACTIVE'
   RETURNING l.lease_until INTO until_at;
   at_time:=clock_timestamp();
   IF until_at IS NULL OR until_at<=at_time THEN
     PERFORM public.vpn_shared_connection_release(p_entitlement,p_connection,p_node,p_peer);
     RETURN jsonb_build_object('result','DENY_PEER','leaseUntil',NULL);
   END IF;
 END IF;
 RETURN jsonb_build_object('result',r,'leaseUntil',until_at);
END $$;
REVOKE ALL ON FUNCTION public.vpn_shared_admission_node_identity(text),
 public.vpn_shared_admission_decide(uuid,uuid,text,text,text,text,text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vpn_shared_admission_node_identity(text),
 public.vpn_shared_admission_decide(uuid,uuid,text,text,text,text,text,text,text,timestamptz)
 TO mnebyvpn_connection_admission;
-- Keep earlier verified RPC for compatibility; new gateway uses the bounded result.
COMMIT;
