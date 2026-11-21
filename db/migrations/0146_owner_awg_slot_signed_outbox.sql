-- Stage 2E: strictly dormant signed AWG V2 per-slot outbox.
-- Legacy AWG V1 tables/keys/worker/network runtime remain unchanged.
-- Requires 0141..0145. DB has no automatic network delivery capability.
BEGIN;

INSERT INTO public.vpn_release_flags(feature,enabled)
VALUES('owner_awg_slot_v2',false)
ON CONFLICT(feature) DO NOTHING;

CREATE TABLE public.owner_vpn_awg_slot_allocations (
  node_id text NOT NULL,
  entitlement_id uuid NOT NULL,
  slot_number smallint NOT NULL CHECK(slot_number BETWEEN 1 AND 3),
  peer_public_key text NOT NULL
    CHECK(peer_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  client_ipv4 inet NOT NULL CHECK(family(client_ipv4)=4 AND masklen(client_ipv4)=32),
  billing_revision bigint NOT NULL CHECK(billing_revision BETWEEN 1 AND 1000000000),
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000000000),
  expires_at timestamptz,
  state text NOT NULL CHECK(state IN ('staged','applied','revoked')),
  last_command_sha256 text NOT NULL CHECK(last_command_sha256 ~ '^[a-f0-9]{64}$'),
  last_signed_at timestamptz NOT NULL,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(node_id,entitlement_id,slot_number),
  UNIQUE(node_id,peer_public_key),
  UNIQUE(node_id,client_ipv4),
  FOREIGN KEY(node_id,entitlement_id,slot_number)
    REFERENCES public.owner_vpn_awg_peer_reservations(node_id,entitlement_id,slot_number)
    ON DELETE RESTRICT,
  FOREIGN KEY(node_id,entitlement_id,slot_number)
    REFERENCES public.vpn_awg_ipv4_claims(node_id,entitlement_id,device_slot)
    ON DELETE RESTRICT,
  CHECK(state='revoked' OR expires_at IS NOT NULL),
  CHECK(state<>'revoked' OR expires_at IS NULL),
  CHECK(state<>'applied' OR applied_at IS NOT NULL)
);

CREATE FUNCTION public.owner_vpn_awg_guard_slot_allocation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $v2_alloc_guard$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.node_id IS DISTINCT FROM OLD.node_id OR
       NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id OR
       NEW.slot_number IS DISTINCT FROM OLD.slot_number OR
       NEW.peer_public_key IS DISTINCT FROM OLD.peer_public_key OR
       NEW.client_ipv4 IS DISTINCT FROM OLD.client_ipv4 OR
       NEW.created_at IS DISTINCT FROM OLD.created_at OR
       NEW.revision<OLD.revision OR
       (NEW.revision=OLD.revision AND
         (NOT (
           (OLD.state='staged' AND NEW.state='applied') OR
           (OLD.state='revoked' AND NEW.state='revoked' AND
              OLD.applied_at IS NULL AND NEW.applied_at IS NOT NULL)
          ) OR
          NEW.billing_revision IS DISTINCT FROM OLD.billing_revision OR
          NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
          NEW.last_signed_at IS DISTINCT FROM OLD.last_signed_at OR
          NEW.last_command_sha256 IS DISTINCT FROM OLD.last_command_sha256))
       THEN
      RAISE EXCEPTION 'AWG V2 slot binding is immutable and revision must increase except for signed ACK';
    END IF;
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.vpn_awg_ipv4_claims c
    WHERE c.node_id=NEW.node_id
      AND c.entitlement_id=NEW.entitlement_id
      AND c.device_slot=NEW.slot_number
      AND c.peer_public_key=NEW.peer_public_key
      AND c.client_ipv4=NEW.client_ipv4
      AND c.source='owner_slot'
  ) THEN
    RAISE EXCEPTION 'AWG V2 slot allocation must match the immutable owner IP claim';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.owner_vpn_awg_peer_reservations r
    WHERE r.node_id=NEW.node_id AND r.entitlement_id=NEW.entitlement_id
      AND r.slot_number=NEW.slot_number AND r.peer_public_key=NEW.peer_public_key
  ) THEN
    RAISE EXCEPTION 'AWG V2 slot allocation does not match owner public key';
  END IF;
  RETURN NEW;
END;
$v2_alloc_guard$;

CREATE TRIGGER owner_vpn_awg_slot_allocation_guard
BEFORE INSERT OR UPDATE ON public.owner_vpn_awg_slot_allocations
FOR EACH ROW EXECUTE FUNCTION public.owner_vpn_awg_guard_slot_allocation();

CREATE TABLE public.owner_vpn_awg_slot_command_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id text NOT NULL,
  entitlement_id uuid NOT NULL,
  slot_number smallint NOT NULL CHECK(slot_number BETWEEN 1 AND 3),
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 1000000000),
  billing_revision bigint CHECK(billing_revision IS NULL OR billing_revision>=1),
  op text NOT NULL CHECK(op IN ('grant','revoke')),
  signed_command jsonb NOT NULL CHECK(jsonb_typeof(signed_command)='object'),
  command_sha256 text NOT NULL UNIQUE CHECK(command_sha256 ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_delivery_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','claimed','applied','stale','failed')),
  claimed_at timestamptz,
  applied_at timestamptz,
  node_receipt_sha256 text CHECK(
    node_receipt_sha256 IS NULL OR node_receipt_sha256 ~ '^[a-f0-9]{64}$'
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(node_id,entitlement_id,slot_number)
    REFERENCES public.owner_vpn_awg_slot_allocations(node_id,entitlement_id,slot_number)
    ON DELETE RESTRICT,
  UNIQUE(node_id,entitlement_id,slot_number,revision),
  CHECK(expires_delivery_at>issued_at),
  CHECK(expires_delivery_at<=issued_at+interval '40 seconds'),
  CHECK((op='grant' AND billing_revision IS NOT NULL)
        OR (op='revoke' AND billing_revision IS NULL)),
  CHECK(state<>'claimed' OR claimed_at IS NOT NULL),
  CHECK(state<>'applied' OR
        (applied_at IS NOT NULL AND node_receipt_sha256 IS NOT NULL))
);
CREATE INDEX owner_vpn_awg_slot_outbox_pending_idx
  ON public.owner_vpn_awg_slot_command_outbox(state,issued_at)
  WHERE state IN ('queued','claimed');

REVOKE ALL ON public.owner_vpn_awg_slot_allocations,
  public.owner_vpn_awg_slot_command_outbox FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owner_vpn_awg_guard_slot_allocation() FROM PUBLIC;

-- Deliberately no GRANT or live consumer. Operator-only identity checking
-- remains in 0141..0145. A distinct audited controller release is mandatory.
COMMIT;
