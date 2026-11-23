-- Isolated PostgreSQL node pin review regression. No real VPS identities.
BEGIN;
DO $verify$
DECLARE
 v_spki text;
 v_der bytea;
 v_pin text;
 v_blocked boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM public.vpn_shared_connection_nodes)
 THEN RAISE EXCEPTION 'Review test expects dormant node registry'; END IF;
 v_der:=decode('302a300506032b6570032100'||repeat('11',32),'hex');
 v_spki:=rtrim(translate(encode(v_der,'base64'),'+/','-_'),'=');
 v_pin:=encode(sha256(v_der),'hex');
 IF length(v_spki)<>59 OR length(v_pin)<>64
 THEN RAISE EXCEPTION 'Ed25519 pin fixture malformed'; END IF;

 INSERT INTO public.vpn_node_enrollment_inventory(
  node_id,endpoint_host,identity_public_spki)
 VALUES('review-de','review-de.example.org',v_spki);
 INSERT INTO public.vpn_shared_connection_nodes(
  node_id,country_code,node_public_key_sha256,enabled)
 VALUES('review-de','DE',repeat('f',64),false);
 v_blocked:=false;
 BEGIN
  UPDATE public.vpn_shared_connection_nodes SET enabled=true
  WHERE node_id='review-de';
 EXCEPTION WHEN OTHERS THEN v_blocked:=true; END;
 IF NOT v_blocked THEN RAISE EXCEPTION 'Unenrolled mismatched node enabled'; END IF;
 UPDATE public.vpn_node_enrollment_inventory
 SET status='approved',approved_at=clock_timestamp() WHERE node_id='review-de';
 INSERT INTO public.vpn_node_enrollment_challenges(
  challenge_id,node_id,nonce_sha256,issued_at,expires_at,consumed_at)
 VALUES(gen_random_uuid(),'review-de',repeat('c',64),
   clock_timestamp()-interval '1 second',
   clock_timestamp()+interval '1 minute',clock_timestamp());
 UPDATE public.vpn_node_enrollment_inventory
 SET status='enrolled',enrolled_at=clock_timestamp() WHERE node_id='review-de';

 v_blocked:=false;
 BEGIN
  UPDATE public.vpn_shared_connection_nodes SET enabled=true
  WHERE node_id='review-de';
 EXCEPTION WHEN OTHERS THEN v_blocked:=true; END;
 IF NOT v_blocked THEN RAISE EXCEPTION 'Invalid SHA256 accepted for enrolled node'; END IF;

 DELETE FROM public.vpn_shared_connection_nodes
 WHERE node_id='review-de' AND enabled=false;
 INSERT INTO public.vpn_shared_connection_nodes(
  node_id,country_code,node_public_key_sha256,enabled)
 VALUES('review-de','DE',v_pin,true);
 IF NOT EXISTS(SELECT 1 FROM public.vpn_shared_connection_nodes
   WHERE node_id='review-de' AND enabled)
 THEN RAISE EXCEPTION 'Approved Ed25519 identity falsely denied'; END IF;

 v_blocked:=false;
 BEGIN
  UPDATE public.vpn_shared_connection_nodes
    SET country_code='FI' WHERE node_id='review-de';
 EXCEPTION WHEN OTHERS THEN v_blocked:=true; END;
 IF NOT v_blocked THEN RAISE EXCEPTION 'Country swap accepted'; END IF;

 v_blocked:=false;
 BEGIN
  UPDATE public.vpn_shared_connection_nodes
    SET node_public_key_sha256=repeat('e',64) WHERE node_id='review-de';
 EXCEPTION WHEN OTHERS THEN v_blocked:=true; END;
 IF NOT v_blocked THEN RAISE EXCEPTION 'Node key substitution accepted'; END IF;

 UPDATE public.vpn_shared_connection_nodes SET enabled=false
 WHERE node_id='review-de';
 UPDATE public.vpn_node_enrollment_inventory SET status='revoked'
 WHERE node_id='review-de';
 v_blocked:=false;
 BEGIN
  UPDATE public.vpn_shared_connection_nodes SET enabled=true
  WHERE node_id='review-de';
 EXCEPTION WHEN OTHERS THEN v_blocked:=true; END;
 IF NOT v_blocked THEN RAISE EXCEPTION 'Revoked node silently reenabled'; END IF;
END $verify$;
ROLLBACK;
