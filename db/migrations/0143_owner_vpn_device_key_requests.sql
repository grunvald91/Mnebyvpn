-- Stage 2A: strictly private owner-requested X25519 PUBLIC keys for three
-- reserved manual-sale seats. NOT an AWG peer, command or network grant.
-- No public website, client or worker can execute this routine.
BEGIN;

CREATE FUNCTION public.owner_vpn_request_device_key(
  p_operator_telegram_id bigint,
  p_order_id uuid,
  p_slot_number smallint,
  p_peer_public_key text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $owner_slot$
DECLARE
  v_entitlement_id uuid;
  v_state text;
  v_existing_key text;
BEGIN
  IF p_operator_telegram_id IS NULL OR p_operator_telegram_id<=0
     OR p_order_id IS NULL OR p_slot_number IS NULL
     OR p_slot_number NOT BETWEEN 1 AND 3
     OR p_peer_public_key IS NULL
     OR p_peer_public_key !~ '^[A-Za-z0-9+/]{43}=$' THEN
    RETURN 'DENY_INPUT';
  END IF;

  -- No plaintext client private key is accepted or stored. Reject malformed
  -- base64, non-canonical encodings, and the all-zero X25519 public value.
  BEGIN
    IF pg_catalog.length(pg_catalog.decode(p_peer_public_key,'base64'))<>32
       OR pg_catalog.encode(pg_catalog.decode(p_peer_public_key,'base64'),'base64')
          <>p_peer_public_key
       OR pg_catalog.decode(p_peer_public_key,'base64')
          =pg_catalog.decode(pg_catalog.repeat('00',32),'hex') THEN
      RETURN 'DENY_INPUT';
    END IF;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN 'DENY_INPUT';
  END;

  -- Never rely on a username alone. The caller is the private Telegram bot,
  -- which must independently authenticate the Telegram owner before use.
  -- The original manual-sale order and immutable 3-seat terms are required.
  -- Require current VPN ACTIVE + exact node ACK, not merely a PAID row.
  SELECT e.id INTO v_entitlement_id
  FROM public.manual_sales AS m
  JOIN public.orders AS o ON o.id=m.order_id
  JOIN public.order_terms AS t ON t.order_id=o.id
  JOIN public.entitlements AS e ON e.source_order_id=o.id
    AND e.account_id=o.account_id AND e.product='vpn'
  JOIN public.provisioning_state AS p ON p.entitlement_id=e.id
    AND p.adapter='vpn' AND p.applied_revision=e.revision
    AND p.last_observed_at IS NOT NULL
  WHERE m.order_id=p_order_id
    AND m.operator_telegram_id=p_operator_telegram_id
    AND o.provider='manual_sale' AND o.product='bundle' AND o.state='PAID'
    AND t.plan_id='bundle_30d_3device' AND t.device_limit=3
    AND e.state='ACTIVE' AND e.expires_at>clock_timestamp()
  -- Lock the PAID order, immutable terms and exact VPN ACK alongside the
  -- entitlement: concurrent refund, revision or ACK invalidation must not
  -- race between authorization and the seat UPDATE.
  FOR SHARE OF o,t,e,p;
  IF v_entitlement_id IS NULL THEN RETURN 'DENY_ACCESS'; END IF;

  SELECT s.state,s.peer_public_key INTO v_state,v_existing_key
  FROM public.owner_vpn_device_seats AS s
  WHERE s.entitlement_id=v_entitlement_id AND s.slot_number=p_slot_number
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_ACCESS'; END IF;

  IF v_state='REVOKED' THEN RETURN 'DENY_REVOKED'; END IF;
  IF v_state='REQUESTED' THEN
    IF v_existing_key=p_peer_public_key THEN RETURN 'ALREADY_REQUESTED'; END IF;
    RETURN 'DENY_BOUND';
  END IF;
  IF v_state<>'EMPTY' OR v_existing_key IS NOT NULL THEN
    RETURN 'DENY_BOUND';
  END IF;

  -- The global UNIQUE(peer_public_key) also blocks reusing a key from another
  -- entitlement or an already revoked slot. Concurrent duplicates fail closed.
  BEGIN
    UPDATE public.owner_vpn_device_seats
    SET state='REQUESTED',peer_public_key=p_peer_public_key,
        registered_at=clock_timestamp(),revoked_at=NULL
    WHERE entitlement_id=v_entitlement_id AND slot_number=p_slot_number
      AND state='EMPTY' AND peer_public_key IS NULL;
  EXCEPTION WHEN unique_violation THEN
    RETURN 'DENY_KEY_IN_USE';
  END;
  RETURN 'REQUESTED';
END;
$owner_slot$;

REVOKE ALL ON FUNCTION public.owner_vpn_request_device_key(bigint,uuid,smallint,text)
  FROM PUBLIC;
DO $private_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
             WHERE rolname='mnebyvpn_bot') THEN
    GRANT EXECUTE ON FUNCTION public.owner_vpn_request_device_key(bigint,uuid,smallint,text)
      TO mnebyvpn_bot;
  END IF;
END;
$private_grant$;

-- No new GRANT on owner_vpn_device_seats, vpn_awg_peer_allocations,
-- vpn_awg_command_outbox or nodekit. These REQUESTED keys cannot connect.
COMMIT;
