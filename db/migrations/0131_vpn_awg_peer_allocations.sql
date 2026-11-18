-- Controller-side AmneziaWG peer IPAM and entitlement ledger.
-- DORMANT: no public API/automatic publication and no FI server inserted.
BEGIN;

CREATE TABLE vpn_awg_node_pools (
  node_id text PRIMARY KEY REFERENCES vpn_node_enrollment_inventory(node_id),
  endpoint_host text NOT NULL,
  server_public_key text NOT NULL
    CHECK (server_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  listen_port integer NOT NULL DEFAULT 51821 CHECK (listen_port BETWEEN 1 AND 65535),
  subnet_cidr cidr NOT NULL UNIQUE
    CHECK (
      family(subnet_cidr) = 4 AND masklen(subnet_cidr) = 24
      AND subnet_cidr <<= cidr '10.73.0.0/16'
    ),
  state text NOT NULL DEFAULT 'staged'
    CHECK (state IN ('staged','verified','degraded','disabled')),
  external_e2e_proof_sha256 text CHECK (
    external_e2e_proof_sha256 IS NULL OR
    external_e2e_proof_sha256 ~ '^[a-f0-9]{64}$'
  ),
  verified_at timestamptz,
  CHECK (state <> 'verified' OR
         (external_e2e_proof_sha256 IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE TABLE vpn_awg_peer_allocations (
  node_id text NOT NULL REFERENCES vpn_awg_node_pools(node_id),
  entitlement_id uuid NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  peer_public_key text NOT NULL
    CHECK (peer_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  client_ipv4 inet NOT NULL
    CHECK (family(client_ipv4) = 4 AND masklen(client_ipv4) = 32),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000000),
  expires_at timestamptz,
  state text NOT NULL DEFAULT 'staged'
    CHECK (state IN ('staged','applied','revoked','expired')),
  last_signed_at timestamptz,
  last_command_sha256 text CHECK (
    last_command_sha256 IS NULL OR
    last_command_sha256 ~ '^[a-f0-9]{64}$'
  ),
  applied_at timestamptz,
  PRIMARY KEY (node_id, entitlement_id),
  UNIQUE (node_id, peer_public_key),
  UNIQUE (node_id, client_ipv4),
  CHECK (state IN ('revoked','expired') OR expires_at IS NOT NULL),
  CHECK (state <> 'applied' OR applied_at IS NOT NULL)
);

-- Reject cross-subnet grants even from an accidentally overprivileged writer.
CREATE FUNCTION vpn_awg_enforce_address_pool()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pool cidr;
BEGIN
  SELECT subnet_cidr INTO pool FROM vpn_awg_node_pools
    WHERE node_id=NEW.node_id FOR SHARE;
  IF pool IS NULL OR NOT NEW.client_ipv4 << pool OR
     NEW.client_ipv4 = network(pool)::inet OR
     NEW.client_ipv4 = broadcast(pool)::inet THEN
    RAISE EXCEPTION 'AWG client address outside approved node pool';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.node_id IS DISTINCT FROM OLD.node_id OR
       NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id OR
       NEW.peer_public_key IS DISTINCT FROM OLD.peer_public_key OR
       NEW.client_ipv4 IS DISTINCT FROM OLD.client_ipv4 THEN
       RAISE EXCEPTION 'AWG peer binding is immutable; use controlled rotation';
    END IF;
    IF NEW.revision < OLD.revision THEN
      RAISE EXCEPTION 'AWG access revision must not decrease';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vpn_awg_address_immutability
  BEFORE INSERT OR UPDATE ON vpn_awg_peer_allocations
  FOR EACH ROW EXECUTE FUNCTION vpn_awg_enforce_address_pool();

-- Both release flags default FALSE. An audited E2E release is separate.
INSERT INTO vpn_release_flags(feature, enabled)
 VALUES ('vpn_awg_clients', false)
 ON CONFLICT(feature) DO NOTHING;

REVOKE ALL ON vpn_awg_node_pools,vpn_awg_peer_allocations FROM PUBLIC;
REVOKE ALL ON FUNCTION vpn_awg_enforce_address_pool() FROM PUBLIC;
COMMIT;
