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
  v_verified_node text;
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
  -- Lock paid order, terms, exact VPN ACK and registered seat until COMMIT.
  FOR SHARE OF o,t,e,p,s;
  IF v_entitlement IS NULL THEN RETURN 'DENY_ACCESS'; END IF;

  -- An independently verified and enrolled node is required; a staged node
  -- or revoked identity is never eligible. Still NO network effect.
  -- Lock both verified pool and node identity against concurrent revocation.
  SELECT p.node_id INTO v_verified_node
  FROM public.vpn_awg_node_pools p
  JOIN public.vpn_node_enrollment_inventory n ON n.node_id=p.node_id
  WHERE p.node_id=p_node_id AND p.state='verified'
    AND p.external_e2e_proof_sha256 ~ '^[a-f0-9]{64}$'
    AND p.verified_at>clock_timestamp()-interval '1 hour'
    AND p.verified_at<=clock_timestamp()+interval '30 seconds'
    AND n.status='enrolled' AND n.endpoint_host=p.endpoint_host
  FOR SHARE OF p,n;
  IF v_verified_node IS NULL THEN RETURN 'DENY_NODE'; END IF;

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


-- Historical RESERVED rows are NOT grants. This private diagnostic view
-- excludes stale, refunded, suspended or expired entitlements, mismatched
-- key/revision/ACK, and disabled/revoked nodes. No consumer gets privileges.
CREATE VIEW public.owner_vpn_awg_eligible_peer_reservations AS
SELECT r.node_id,r.entitlement_id,r.slot_number,r.peer_public_key,
       r.billing_revision,r.created_at
FROM public.owner_vpn_awg_peer_reservations r
JOIN public.owner_vpn_device_seats s
  ON s.entitlement_id=r.entitlement_id AND s.slot_number=r.slot_number
  AND s.state='REQUESTED' AND s.revoked_at IS NULL
  AND s.peer_public_key=r.peer_public_key
JOIN public.entitlements e ON e.id=r.entitlement_id
  AND e.product='vpn' AND e.state='ACTIVE'
  AND e.revision=r.billing_revision AND e.expires_at>clock_timestamp()
JOIN public.orders o ON o.id=e.source_order_id
  AND o.account_id=e.account_id AND o.provider='manual_sale'
  AND o.product='bundle' AND o.state='PAID'
JOIN public.manual_sales m ON m.order_id=o.id
JOIN public.order_terms t ON t.order_id=o.id
  AND t.plan_id='bundle_30d_3device' AND t.device_limit=3
JOIN public.provisioning_state ps ON ps.entitlement_id=e.id
  AND ps.adapter='vpn' AND ps.applied_revision=e.revision
  AND ps.last_observed_at IS NOT NULL
JOIN public.vpn_awg_node_pools p ON p.node_id=r.node_id
  AND p.state='verified'
  AND p.external_e2e_proof_sha256 ~ '^[a-f0-9]{64}$'
  AND p.verified_at>clock_timestamp()-interval '1 hour'
  AND p.verified_at<=clock_timestamp()+interval '30 seconds'
JOIN public.vpn_node_enrollment_inventory n ON n.node_id=p.node_id
  AND n.status='enrolled' AND n.endpoint_host=p.endpoint_host;
REVOKE ALL ON public.owner_vpn_awg_eligible_peer_reservations FROM PUBLIC;
-- Even this eligible view is not authorization to sign or publish a peer.

-- No worker/web role gets access. No live credential, client IP or
-- signed nodekit command is generated.
COMMIT;
