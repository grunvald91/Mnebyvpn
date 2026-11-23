-- Shared RU188 admission for active VPN connections from Germany and Finland.
-- NO LIVE ENFORCEMENT OR RELEASE: requires signed node observers on BOTH
-- Xray/VLESS and AmneziaWG and a local fail-closed lease watchdog.
BEGIN;
DO $preflight$
BEGIN
 IF to_regclass('public.vpn_release_flags') IS NULL OR
    to_regclass('public.order_terms') IS NULL OR
    NOT EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid='public.order_terms'::regclass
                  AND attname='device_limit' AND NOT attisdropped) THEN
   RAISE EXCEPTION 'Immutable order_terms.device_limit is required';
 END IF;
END $preflight$;
INSERT INTO public.vpn_release_flags(feature,enabled)
 VALUES('vpn_shared_connection_admission',false) ON CONFLICT DO NOTHING;

-- Exact approved node/country binding; nothing registered or enabled on install.
CREATE TABLE public.vpn_shared_connection_nodes (
 node_id text PRIMARY KEY CHECK(node_id ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
 country_code text NOT NULL UNIQUE CHECK(country_code IN ('DE','FI')),
 node_public_key_sha256 text NOT NULL CHECK(node_public_key_sha256 ~ '^[a-f0-9]{64}$'),
 enabled boolean NOT NULL DEFAULT false
);
-- Entries for both countries occupy ONE entitlement-wide bucket.
-- Retain replay tombstones, never re-admit an expired/released connection_id.
CREATE TABLE public.vpn_shared_connection_leases (
 entitlement_id uuid NOT NULL REFERENCES public.entitlements(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL,
 node_id text NOT NULL REFERENCES public.vpn_shared_connection_nodes(node_id),
 peer_sha256 text NOT NULL CHECK(peer_sha256 ~ '^[a-f0-9]{64}$'),
 entitlement_revision bigint NOT NULL CHECK(entitlement_revision > 0),
 state text NOT NULL CHECK(state IN ('ACTIVE','RELEASED')),
 admitted_at timestamptz NOT NULL,
 last_heartbeat_at timestamptz NOT NULL,
 lease_until timestamptz NOT NULL,
 PRIMARY KEY(entitlement_id,connection_id),
 CHECK(lease_until>=admitted_at)
);
CREATE INDEX vpn_shared_connection_occupancy_idx
 ON public.vpn_shared_connection_leases(entitlement_id,lease_until)
 WHERE state='ACTIVE';

-- Dedicated non-login admission role; website/bot have no call privileges.
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles
               WHERE rolname='mnebyvpn_connection_admission') THEN
   CREATE ROLE mnebyvpn_connection_admission NOLOGIN NOINHERIT;
 END IF;
END $role$;

CREATE FUNCTION public.vpn_shared_connection_claim(
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
 SELECT e.revision,e.expires_at,t.device_limit INTO v_revision,v_expiry,v_cap
 FROM public.entitlements e
 JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
 JOIN public.order_terms t ON t.order_id=o.id
 JOIN public.provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn'
 WHERE e.id=p_entitlement_id AND e.product='vpn' AND e.state='ACTIVE'
   AND e.expires_at>v_time AND o.state='PAID'
   AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL
   AND t.device_limit BETWEEN 1 AND 16;
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

CREATE FUNCTION public.vpn_shared_connection_release(
 p_entitlement_id uuid,p_connection_id uuid,p_node_id text,p_peer_sha256 text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $release$
DECLARE v_previous public.vpn_shared_connection_leases%ROWTYPE;
BEGIN
 IF p_entitlement_id IS NULL OR p_connection_id IS NULL OR p_node_id IS NULL
    OR p_peer_sha256 IS NULL OR p_peer_sha256 !~ '^[a-f0-9]{64}$' THEN
   RETURN 'DENY_INVALID';
 END IF;
 -- Must still be possible on refund, expiry or disabled feature flag.
 PERFORM 1 FROM public.entitlements WHERE id=p_entitlement_id FOR UPDATE;
 IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
 SELECT * INTO v_previous FROM public.vpn_shared_connection_leases
   WHERE entitlement_id=p_entitlement_id AND connection_id=p_connection_id;
 IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
 IF v_previous.node_id<>p_node_id OR
    v_previous.peer_sha256<>p_peer_sha256 THEN
   RETURN 'DENY_BINDING';
 END IF;
 IF v_previous.state='RELEASED' THEN RETURN 'ALREADY_RELEASED'; END IF;
 UPDATE public.vpn_shared_connection_leases SET
  state='RELEASED',lease_until=LEAST(lease_until,clock_timestamp())
 WHERE entitlement_id=p_entitlement_id AND connection_id=p_connection_id;
 RETURN 'RELEASED';
END $release$;

REVOKE ALL ON public.vpn_shared_connection_nodes,
 public.vpn_shared_connection_leases FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vpn_shared_connection_claim(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vpn_shared_connection_release(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vpn_shared_connection_claim(uuid,uuid,text,text),
 public.vpn_shared_connection_release(uuid,uuid,text,text)
 TO mnebyvpn_connection_admission;
COMMIT;
