-- Private controller-side RPC fence. No public listener or node enrollment.
BEGIN;
CREATE TABLE public.fi_dns_meter_rpc_nonces (
 nonce text PRIMARY KEY CHECK(nonce ~ '^[a-f0-9]{64}$'),
 first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fi_dns_meter_rpc_nonces_age ON public.fi_dns_meter_rpc_nonces(first_seen_at);
REVOKE ALL ON public.fi_dns_meter_rpc_nonces FROM PUBLIC;

CREATE FUNCTION public.fi_dns_meter_verified_apply(
 p_op text,p_request uuid,p_digest text,p_node_pin text,p_nonce text,p_issued timestamptz
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_spki text; v_der bytea;
BEGIN
 IF p_op IS NULL OR p_op NOT IN ('reserve','settle','release')
 OR p_request IS NULL OR p_node_pin IS NULL OR p_node_pin !~ '^[a-f0-9]{64}$'
 OR p_nonce IS NULL OR p_nonce !~ '^[a-f0-9]{64}$' OR p_nonce=repeat('0',64)
 OR p_issued IS NULL OR abs(extract(epoch FROM (clock_timestamp()-p_issued)))>15
 OR (p_op='reserve' AND (p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'))
 OR (p_op<>'reserve' AND p_digest IS NOT NULL)
 THEN RETURN 'DENY_INVALID'; END IF;
 -- Lock enrolled identity for the duration of the transaction. No VPN gate
 -- dependency: the same trusted node identity is reused, not VPN admission.
 SELECT identity_public_spki INTO v_spki FROM public.vpn_node_enrollment_inventory
 WHERE node_id='fi-test-01' AND status='enrolled' FOR SHARE;
 IF NOT FOUND OR v_spki IS NULL OR v_spki !~ '^[A-Za-z0-9_-]{59}$'
 THEN RETURN 'DENY_NODE'; END IF;
 v_der:=decode(translate(v_spki,'-_','+/')||'=','base64');
 IF octet_length(v_der)<>44 OR substring(v_der from 1 for 12)<>decode('302a300506032b6570032100','hex')
 OR encode(sha256(v_der),'hex')<>p_node_pin THEN RETURN 'DENY_NODE'; END IF;
 -- Recheck after waiting on the enrollment lock; a stale request must not
 -- enter the replay ledger or meter merely because it was fresh on arrival.
 IF abs(extract(epoch FROM (clock_timestamp()-p_issued)))>15 THEN RETURN 'DENY_INVALID'; END IF;
 -- Caller must already have verified the actual signature against the pin.
 INSERT INTO public.fi_dns_meter_rpc_nonces(nonce) VALUES(p_nonce) ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN 'DENY_REPLAY'; END IF;
 IF abs(extract(epoch FROM (clock_timestamp()-p_issued)))>15 THEN RETURN 'DENY_INVALID'; END IF;
 RETURN public.fi_dns_meter_apply(p_op,p_request,p_digest);
END $$;
REVOKE ALL ON FUNCTION public.fi_dns_meter_verified_apply(text,uuid,text,text,text,timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fi_dns_meter_apply(text,uuid,text) FROM mnebyvpn_fi_dns_meter;
GRANT EXECUTE ON FUNCTION public.fi_dns_meter_verified_apply(text,uuid,text,text,text,timestamptz) TO mnebyvpn_fi_dns_meter;
-- Explicit bounded maintenance, separate from the request worker. A nonce
-- cannot be accepted again once its signed timestamp is outside +/-15s.
-- Retain a generous safety margin; do not prune durable request tombstones.
CREATE FUNCTION public.fi_dns_meter_prune_nonces()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_deleted integer;
BEGIN
 WITH expired AS (
   SELECT nonce FROM public.fi_dns_meter_rpc_nonces
   WHERE first_seen_at<clock_timestamp()-interval '10 minutes'
   ORDER BY first_seen_at LIMIT 10000 FOR UPDATE SKIP LOCKED
 )
 DELETE FROM public.fi_dns_meter_rpc_nonces n USING expired e WHERE n.nonce=e.nonce;
 GET DIAGNOSTICS v_deleted=ROW_COUNT;
 RETURN v_deleted;
END $$;
REVOKE ALL ON FUNCTION public.fi_dns_meter_prune_nonces() FROM PUBLIC;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_fi_dns_maintenance') THEN
  CREATE ROLE mnebyvpn_fi_dns_maintenance NOLOGIN NOINHERIT;
 END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.fi_dns_meter_prune_nonces() TO mnebyvpn_fi_dns_maintenance;
COMMIT;
