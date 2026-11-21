-- Stage 2B: side-by-side AWG peer intent by (node, entitlement, device seat).
-- No IP allocation, no signed command, no live peer and NO change to the
-- legacy vpn_awg_peer_allocations / vpn_awg_command_outbox PKs.
-- Requires 0142 reserved seats and 0143 owner-only public key registration.
BEGIN;

CREATE TABLE public.owner_vpn_awg_peer_reservations (
  node_id text NOT NULL REFERENCES public.vpn_awg_node_pools(node_id),
  entitlement_id uuid NOT NULL,
  slot_number smallint NOT NULL CHECK (slot_number BETWEEN 1 AND 3),
  peer_public_key text NOT NULL
    CHECK (peer_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  billing_revision bigint NOT NULL CHECK (billing_revision BETWEEN 1 AND 1000000000),
  -- A reservation must never be mistaken for a network-installed peer.
  state text NOT NULL DEFAULT 'RESERVED' CHECK (state='RESERVED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (node_id,entitlement_id,slot_number),
  UNIQUE (node_id,peer_public_key),
  FOREIGN KEY (entitlement_id,slot_number)
    REFERENCES public.owner_vpn_device_seats(entitlement_id,slot_number)
    ON DELETE RESTRICT
);
REVOKE ALL ON public.owner_vpn_awg_peer_reservations FROM PUBLIC;

CREATE FUNCTION public.owner_vpn_reserve_awg_peer_slot(
  p_operator_telegram_id bigint,
  p_order_id uuid,
  p_slot_number smallint,
  p_node_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $reserve_peer$
DECLARE
  v_entitlement uuid;
  v_revision bigint;
  v_peer_key text;
  v_existing public.owner_vpn_awg_peer_reservations%ROWTYPE;
BEGIN
  IF p_operator_telegram_id IS NULL OR p_operator_telegram_id<=0
     OR p_order_id IS NULL OR p_slot_number IS NULL
     OR p_slot_number NOT BETWEEN 1 AND 3
     OR p_node_id IS NULL OR p_node_id !~ '^[a-z0-9][a-z0-9-]{2,39}$'
     OR right(p_node_id,1)='-' THEN
    RETURN 'DENY_INPUT';
  END IF;

  -- Only an owner-attested paid manual sale, an ACTIVE exact-revision VPN ACK,
  -- and a pre-registered public key can create a non-network reservation.
  SELECT e.id,e.revision,s.peer_public_key
    INTO v_entitlement,v_revision,v_peer_key
  FROM public.manual_sales m
  JOIN public.orders o ON o.id=m.order_id
  JOIN public.order_terms t ON t.order_id=o.id
  JOIN public.entitlements e ON e.source_order_id=o.id
    AND e.account_id=o.account_id AND e.product='vpn'
  JOIN public.provisioning_state p ON p.entitlement_id=e.id
    AND p.adapter='vpn' AND p.applied_revision=e.revision
    AND p.last_observed_at IS NOT NULL
  JOIN public.owner_vpn_device_seats s ON s.entitlement_id=e.id
    AND s.slot_number=p_slot_number AND s.state='REQUESTED'
    AND s.peer_public_key IS NOT NULL AND s.revoked_at IS NULL
  WHERE m.order_id=p_order_id AND m.operator_telegram_id=p_operator_telegram_id
    AND o.provider='manual_sale' AND o.product='bundle' AND o.state='PAID'
    AND t.plan_id='bundle_30d_3device' AND t.device_limit=3
    AND e.state='ACTIVE' AND e.expires_at>clock_timestamp()
  FOR SHARE OF e,s;
  IF v_entitlement IS NULL THEN RETURN 'DENY_ACCESS'; END IF;

  -- An independently verified and enrolled node is required; a staged node
  -- or revoked identity is never eligible. Still NO network effect.
  IF NOT EXISTS(
    SELECT 1 FROM public.vpn_awg_node_pools p
    JOIN public.vpn_node_enrollment_inventory n ON n.node_id=p.node_id
    WHERE p.node_id=p_node_id AND p.state='verified'
      AND p.external_e2e_proof_sha256 ~ '^[a-f0-9]{64}$'
      AND p.verified_at>clock_timestamp()-interval '1 hour'
      AND p.verified_at<=clock_timestamp()+interval '30 seconds'
      AND n.status='enrolled' AND n.endpoint_host=p.endpoint_host
  ) THEN RETURN 'DENY_NODE'; END IF;

  INSERT INTO public.owner_vpn_awg_peer_reservations
    (node_id,entitlement_id,slot_number,peer_public_key,billing_revision)
  VALUES(p_node_id,v_entitlement,p_slot_number,v_peer_key,v_revision)
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_existing
  FROM public.owner_vpn_awg_peer_reservations
  WHERE node_id=p_node_id AND entitlement_id=v_entitlement
    AND slot_number=p_slot_number;
  IF NOT FOUND THEN RETURN 'DENY_CONFLICT'; END IF;
  IF v_existing.peer_public_key<>v_peer_key OR
     v_existing.billing_revision<>v_revision THEN
    RETURN 'DENY_STALE';
  END IF;
  -- Caller may safely retry, but this does not indicate an ACK or connection.
  RETURN 'RESERVED';
END;
$reserve_peer$;

REVOKE ALL ON FUNCTION public.owner_vpn_reserve_awg_peer_slot(bigint,uuid,smallint,text)
  FROM PUBLIC;
DO $only_owner$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles
            WHERE rolname='mnebyvpn_bot') THEN
    GRANT EXECUTE ON FUNCTION
      public.owner_vpn_reserve_awg_peer_slot(bigint,uuid,smallint,text)
      TO mnebyvpn_bot;
  END IF;
END;
$only_owner$;

-- No worker/web role gets access. No live credential, client IP or
-- signed nodekit command is generated.
COMMIT;
