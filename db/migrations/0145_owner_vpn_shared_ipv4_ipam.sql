-- Stage 2C: one durable IPv4 uniqueness domain for legacy AWG grants and
-- private per-slot owner intents. No signed nodekit command or network grant.
-- DO NOT enable without coordinated migration + controller worker rollout.
BEGIN;

CREATE TABLE public.vpn_awg_ipv4_claims (
  node_id text NOT NULL REFERENCES public.vpn_awg_node_pools(node_id),
  client_ipv4 inet NOT NULL CHECK (
    family(client_ipv4)=4 AND masklen(client_ipv4)=32
  ),
  entitlement_id uuid NOT NULL,
  device_slot smallint NOT NULL CHECK (device_slot BETWEEN 0 AND 3),
  peer_public_key text NOT NULL
    CHECK (peer_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  source text NOT NULL CHECK (source IN ('legacy','owner_slot')),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(node_id,client_ipv4),
  UNIQUE(node_id,entitlement_id,device_slot),
  UNIQUE(node_id,peer_public_key),
  CHECK (
    (source='legacy' AND device_slot=0) OR
    (source='owner_slot' AND device_slot BETWEEN 1 AND 3)
  )
);

-- Claims are tombstones: never free an address by deleting an entitlement.
-- Historical address reservations prevent new peers stealing an old address.
CREATE FUNCTION public.vpn_awg_guard_ipv4_claim()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $claim_guard$
DECLARE v_pool cidr;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'AWG IPv4 binding is immutable and retained';
  END IF;
  SELECT p.subnet_cidr INTO v_pool FROM public.vpn_awg_node_pools p
    WHERE p.node_id=NEW.node_id FOR SHARE;
  IF v_pool IS NULL OR NOT NEW.client_ipv4 << v_pool
     OR host(NEW.client_ipv4)=host(network(v_pool))
     OR host(NEW.client_ipv4)=host(broadcast(v_pool))
     OR (NEW.source='owner_slot' AND
         host(NEW.client_ipv4)=host(network(v_pool)::inet+1)) THEN
    RAISE EXCEPTION 'AWG IPv4 claim outside subscriber pool';
  END IF;
  IF NEW.source='owner_slot' AND
    host(NEW.client_ipv4)=host(network(v_pool)::inet+253) THEN
    RAISE EXCEPTION 'AWG canary address must not be assigned';
  END IF;
  RETURN NEW;
END;
$claim_guard$;

CREATE TRIGGER vpn_awg_ipv4_claim_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.vpn_awg_ipv4_claims
  FOR EACH ROW EXECUTE FUNCTION public.vpn_awg_guard_ipv4_claim();

-- Block concurrent legacy writes during the one-time exact backfill.
-- Existing signed grants and their IPs are never changed or reissued.
LOCK TABLE public.vpn_awg_peer_allocations IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO public.vpn_awg_ipv4_claims
  (node_id,client_ipv4,entitlement_id,device_slot,peer_public_key,source)
SELECT a.node_id,a.client_ipv4,a.entitlement_id,0,a.peer_public_key,'legacy'
FROM public.vpn_awg_peer_allocations a;

-- Keep every FUTURE legacy allocation represented, even after its entitlement
-- is later revoked or deleted. A conflicting owner IP fails atomically.
CREATE FUNCTION public.vpn_awg_claim_legacy_peer_ipv4()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $claim_legacy$
BEGIN
  INSERT INTO public.vpn_awg_ipv4_claims
    (node_id,client_ipv4,entitlement_id,device_slot,peer_public_key,source)
  VALUES(NEW.node_id,NEW.client_ipv4,NEW.entitlement_id,0,
         NEW.peer_public_key,'legacy');
  RETURN NEW;
END;
$claim_legacy$;

CREATE TRIGGER vpn_awg_legacy_peer_claim_ipv4
  AFTER INSERT ON public.vpn_awg_peer_allocations
  FOR EACH ROW EXECUTE FUNCTION public.vpn_awg_claim_legacy_peer_ipv4();

-- Private owner-only allocator. The existing stage-2B RPC is re-run in the
-- SAME transaction to lock the paid order, seat, exact VPN ACK and node.
-- Lock the pool FIRST to serialize owner allocations on that node.
-- NO client profile, public URL, signed command or nodekit job is created.
CREATE FUNCTION public.owner_vpn_allocate_awg_slot_ipv4(
  p_operator_telegram_id bigint,
  p_order_id uuid,
  p_slot_number smallint,
  p_node_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $owner_ipam$
DECLARE
  v_pool cidr;
  v_auth text;
  v_entitlement uuid;
  v_peer_key text;
  v_revision bigint;
  v_existing public.vpn_awg_ipv4_claims%ROWTYPE;
  v_candidate inet;
BEGIN
  IF p_operator_telegram_id IS NULL OR p_operator_telegram_id<=0
     OR p_order_id IS NULL OR p_slot_number IS NULL
     OR p_slot_number NOT BETWEEN 1 AND 3
     OR p_node_id IS NULL OR p_node_id !~ '^[a-z0-9][a-z0-9-]{2,39}$'
     OR right(p_node_id,1)='-' THEN
    RETURN 'DENY_INPUT';
  END IF;

  SELECT p.subnet_cidr INTO v_pool
  FROM public.vpn_awg_node_pools p WHERE p.node_id=p_node_id
  FOR UPDATE;
  IF v_pool IS NULL THEN RETURN 'DENY_NODE'; END IF;

  v_auth:=public.owner_vpn_reserve_awg_peer_slot(
    p_operator_telegram_id,p_order_id,p_slot_number,p_node_id);
  IF v_auth<>'RESERVED' THEN RETURN v_auth; END IF;

  SELECT r.entitlement_id,r.peer_public_key,r.billing_revision
    INTO v_entitlement,v_peer_key,v_revision
  FROM public.owner_vpn_awg_peer_reservations r
  JOIN public.owner_vpn_awg_eligible_peer_reservations active
    ON active.node_id=r.node_id
    AND active.entitlement_id=r.entitlement_id
    AND active.slot_number=r.slot_number
    AND active.peer_public_key=r.peer_public_key
    AND active.billing_revision=r.billing_revision
  JOIN public.entitlements e ON e.id=r.entitlement_id
    AND e.source_order_id=p_order_id
  WHERE r.node_id=p_node_id AND r.slot_number=p_slot_number
  FOR SHARE OF r;
  IF v_entitlement IS NULL THEN RETURN 'DENY_STALE'; END IF;

  SELECT * INTO v_existing FROM public.vpn_awg_ipv4_claims
  WHERE node_id=p_node_id AND entitlement_id=v_entitlement
    AND device_slot=p_slot_number;
  IF FOUND THEN
    IF v_existing.source<>'owner_slot'
      OR v_existing.peer_public_key<>v_peer_key THEN
      RETURN 'DENY_CONFLICT';
    END IF;
    RETURN 'ALREADY_ALLOCATED';
  END IF;

  -- The subnet is a verified IPv4 /24. .0 network, .1 server/gateway,
  -- .253 independent canary, .255 broadcast are never owner allocations.
  SELECT set_masklen(network(v_pool)::inet + h.n,32)
    INTO v_candidate
  FROM generate_series(2,254) AS h(n)
  WHERE h.n<>253
    AND NOT EXISTS(
      SELECT 1 FROM public.vpn_awg_ipv4_claims c
      WHERE c.node_id=p_node_id
        AND c.client_ipv4=set_masklen(network(v_pool)::inet+h.n,32)
    )
  ORDER BY h.n LIMIT 1;
  IF v_candidate IS NULL THEN RETURN 'DENY_POOL_EXHAUSTED'; END IF;

  INSERT INTO public.vpn_awg_ipv4_claims
    (node_id,client_ipv4,entitlement_id,device_slot,peer_public_key,source)
  VALUES(p_node_id,v_candidate,v_entitlement,p_slot_number,v_peer_key,
         'owner_slot');
  RETURN 'ALLOCATED';
END;
$owner_ipam$;

-- The legacy worker may inspect occupied addresses but may never edit claims.
REVOKE ALL ON public.vpn_awg_ipv4_claims FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vpn_awg_guard_ipv4_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.vpn_awg_claim_legacy_peer_ipv4() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.owner_vpn_allocate_awg_slot_ipv4(bigint,uuid,smallint,text)
  FROM PUBLIC;
DO $ipam_roles$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles
            WHERE rolname='mnebyvpn_awg_delivery') THEN
    GRANT SELECT(node_id,client_ipv4)
      ON public.vpn_awg_ipv4_claims TO mnebyvpn_awg_delivery;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles
            WHERE rolname='mnebyvpn_bot') THEN
    GRANT EXECUTE ON FUNCTION
      public.owner_vpn_allocate_awg_slot_ipv4(bigint,uuid,smallint,text)
      TO mnebyvpn_bot;
  END IF;
END;
$ipam_roles$;

-- All three owner IPs are *dormant* until future independent per-slot
-- signed grant, verified node ACK, and per-seat revoke are implemented.
COMMIT;
