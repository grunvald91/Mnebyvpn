-- Review fix: prevent a country node with a mismatched Ed25519 identity pin
-- from being enabled in the dormant shared DE+FI VPN admission registry.
-- This does NOT provision/enroll any node or enable the feature flag.
BEGIN;
DO $preflight$
BEGIN
 IF to_regclass('public.vpn_shared_connection_nodes') IS NULL OR
    to_regclass('public.vpn_node_enrollment_inventory') IS NULL
 THEN RAISE EXCEPTION 'Enrollment and shared node inventory required'; END IF;
 IF EXISTS(SELECT 1 FROM public.vpn_release_flags
  WHERE feature='vpn_shared_connection_admission' AND enabled)
 THEN RAISE EXCEPTION 'Refusing review migration on active admission gate'; END IF;
 -- A live enabled node requires a separate proof/rollout, never auto-rewrite its pin.
 IF EXISTS(SELECT 1 FROM public.vpn_shared_connection_nodes WHERE enabled)
 THEN RAISE EXCEPTION 'Review and disable existing node admissions before pin guard'; END IF;
END $preflight$;

CREATE FUNCTION public.vpn_shared_connection_node_pin_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $guard$
DECLARE
 v_spki text;
 v_der bytea;
BEGIN
 IF TG_OP='UPDATE' AND
   (NEW.node_id IS DISTINCT FROM OLD.node_id OR
    NEW.country_code IS DISTINCT FROM OLD.country_code OR
    NEW.node_public_key_sha256 IS DISTINCT FROM OLD.node_public_key_sha256)
 THEN RAISE EXCEPTION 'Shared VPN node country and identity are immutable'; END IF;
 IF NOT NEW.enabled THEN RETURN NEW; END IF;
 SELECT i.identity_public_spki INTO v_spki
 FROM public.vpn_node_enrollment_inventory i
 WHERE i.node_id=NEW.node_id AND i.status='enrolled';
 IF NOT FOUND OR v_spki IS NULL OR
    v_spki !~ '^[A-Za-z0-9_-]{59}$'
 THEN RAISE EXCEPTION 'No enrolled pinned Ed25519 node identity'; END IF;
 -- PostgreSQL's base64 decoder is strict; convert canonical base64url to base64.
 v_der:=decode(translate(v_spki,'-_','+/')||'=','base64');
 IF octet_length(v_der)<>44 OR
    substring(v_der from 1 for 12)<>decode('302a300506032b6570032100','hex') OR
    encode(sha256(v_der),'hex')<>NEW.node_public_key_sha256
 THEN RAISE EXCEPTION 'Node inventory SPKI and approved SHA256 do not match'; END IF;
 RETURN NEW;
END $guard$;
CREATE TRIGGER vpn_shared_connection_node_pin_guard_trigger
 BEFORE INSERT OR UPDATE ON public.vpn_shared_connection_nodes
 FOR EACH ROW EXECUTE FUNCTION public.vpn_shared_connection_node_pin_guard();

REVOKE ALL ON FUNCTION public.vpn_shared_connection_node_pin_guard() FROM PUBLIC;
COMMIT;
