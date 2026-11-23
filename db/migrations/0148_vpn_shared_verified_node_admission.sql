-- RU188 private V2 VPN admission. No network listener or live enforcement.
-- Signed Ed25519 request validation MUST occur in a separate trusted gateway.
-- Required migration 0147 remains default OFF; all peer rows start empty.
BEGIN;
DO $preflight$
BEGIN
 IF to_regclass('public.vpn_shared_connection_leases') IS NULL OR
    to_regclass('public.vpn_node_enrollment_inventory') IS NULL OR
    NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_connection_admission')
 THEN RAISE EXCEPTION 'Shared admission 0147 and node registry required'; END IF;
 IF EXISTS(SELECT 1 FROM public.vpn_release_flags
           WHERE feature='vpn_shared_connection_admission' AND enabled)
 THEN RAISE EXCEPTION 'Cannot migrate a live shared admission gate'; END IF;
END $preflight$;

-- Written only by a future trusted controller AFTER verifying a node-signed
-- peer grant + applied ACK. There is deliberately NO writer grant on install.
CREATE TABLE public.vpn_shared_connection_authorized_peers (
 entitlement_id uuid NOT NULL REFERENCES public.entitlements(id) ON DELETE CASCADE,
 node_id text NOT NULL REFERENCES public.vpn_shared_connection_nodes(node_id),
 peer_sha256 text NOT NULL CHECK(peer_sha256 ~ '^[a-f0-9]{64}$'
                               AND peer_sha256<>repeat('0',64)),
 entitlement_revision bigint NOT NULL CHECK(entitlement_revision BETWEEN 1 AND 1000000000),
 grant_receipt_sha256 text NOT NULL CHECK(grant_receipt_sha256 ~ '^[a-f0-9]{64}$'
                                        AND grant_receipt_sha256<>repeat('0',64)),
 verified_at timestamptz NOT NULL,
 grant_expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','REVOKED')),
 PRIMARY KEY(entitlement_id,node_id,peer_sha256),
 UNIQUE(node_id,peer_sha256),
 CHECK(grant_expires_at>verified_at),
 CHECK(grant_expires_at<=verified_at+interval '7 days')
);
CREATE INDEX vpn_shared_peer_binding_idx ON public.vpn_shared_connection_authorized_peers(
 entitlement_id,node_id) WHERE state='ACTIVE';

CREATE FUNCTION public.vpn_shared_peer_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $guard$
BEGIN
 IF NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id OR
    NEW.node_id IS DISTINCT FROM OLD.node_id OR
    NEW.peer_sha256 IS DISTINCT FROM OLD.peer_sha256 OR
    (OLD.state='REVOKED' AND NEW.state<>'REVOKED') OR
    NEW.entitlement_revision<OLD.entitlement_revision OR
    NEW.verified_at<OLD.verified_at
 THEN RAISE EXCEPTION 'Cannot rebind/replay/revive a VPN peer'; END IF;
 IF NEW.state='ACTIVE' AND
    (NEW.entitlement_revision>OLD.entitlement_revision OR
     NEW.grant_expires_at>OLD.grant_expires_at OR
     NEW.verified_at>OLD.verified_at) AND
    NEW.grant_receipt_sha256=OLD.grant_receipt_sha256
 THEN RAISE EXCEPTION 'Fresh independent peer receipt required'; END IF;
 RETURN NEW;
END $guard$;
CREATE TRIGGER vpn_shared_peer_binding_immutable
 BEFORE UPDATE ON public.vpn_shared_connection_authorized_peers
 FOR EACH ROW EXECUTE FUNCTION public.vpn_shared_peer_binding_guard();

-- Durable replay tombstone: no raw client IP, no VPN keys, no user labels.
-- Fresh node requests are cryptographically valid for only +/-15 seconds.
-- A future restricted cleanup may prune rows older than 2 minutes.
CREATE TABLE public.vpn_shared_connection_nonces (
 node_id text NOT NULL REFERENCES public.vpn_shared_connection_nodes(node_id),
 nonce text NOT NULL CHECK(nonce ~ '^[a-f0-9]{64}$' AND nonce<>repeat('0',64)),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'
                                     AND request_sha256<>repeat('0',64)),
 first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(node_id,nonce)
);
CREATE INDEX vpn_shared_connection_nonce_expiry_idx
 ON public.vpn_shared_connection_nonces(first_seen_at);

-- Revoke unsafeguarded V1 direct calls from the scoped admission role.
REVOKE EXECUTE ON FUNCTION
 public.vpn_shared_connection_claim(uuid,uuid,text,text),
 public.vpn_shared_connection_release(uuid,uuid,text,text)
 FROM mnebyvpn_connection_admission;

CREATE FUNCTION public.vpn_shared_connection_verified_apply(
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

REVOKE ALL ON public.vpn_shared_connection_authorized_peers,
 public.vpn_shared_connection_nonces FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vpn_shared_peer_binding_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vpn_shared_connection_verified_apply(
 uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vpn_shared_connection_verified_apply(
 uuid,uuid,text,text,text,text,text) TO mnebyvpn_connection_admission;
COMMIT;
