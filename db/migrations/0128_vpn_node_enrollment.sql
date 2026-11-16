-- One-time Ed25519 node registration. Never a subscription/publication trigger.
-- Operator adds the expected host and key independently before state=approved.
BEGIN;
CREATE TABLE vpn_node_enrollment_inventory (
  node_id text PRIMARY KEY
    CHECK(node_id ~ '^[a-z0-9][a-z0-9-]{2,39}$' AND right(node_id,1)<>'-'),
  endpoint_host text NOT NULL UNIQUE
    CHECK(endpoint_host ~ '^[a-z0-9][a-z0-9.-]{2,251}[a-z0-9]$'
      AND endpoint_host LIKE '%.%' AND endpoint_host NOT LIKE '%..%'
      AND endpoint_host <> 'cdn.servgo.ru'),
  identity_public_spki text NOT NULL UNIQUE
    CHECK(identity_public_spki ~ '^[A-Za-z0-9_-]{59}$'),
  status text NOT NULL DEFAULT 'planned'
    CHECK(status IN ('planned','approved','enrolled','revoked')),
  approved_at timestamptz,
  enrolled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(status NOT IN ('approved','enrolled') OR approved_at IS NOT NULL),
  CHECK(status <> 'enrolled' OR enrolled_at IS NOT NULL)
);
CREATE TABLE vpn_node_enrollment_challenges (
  challenge_id uuid PRIMARY KEY,
  node_id text NOT NULL REFERENCES vpn_node_enrollment_inventory(node_id),
  nonce_sha256 text NOT NULL UNIQUE CHECK(nonce_sha256 ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK(expires_at>issued_at),
  CHECK(expires_at<=issued_at+interval '5 minutes')
);
CREATE INDEX vpn_node_enrollment_challenges_active_idx
  ON vpn_node_enrollment_challenges(node_id,expires_at)
  WHERE consumed_at IS NULL;

-- Identity once enrolled is immutable even if an overly privileged operator
-- accidentally attempts a same-ID key / FQDN swap. Revocation is separate.
CREATE FUNCTION vpn_node_enrollment_guard_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('enrolled','revoked') AND
    (NEW.endpoint_host IS DISTINCT FROM OLD.endpoint_host OR
     NEW.identity_public_spki IS DISTINCT FROM OLD.identity_public_spki OR
     NEW.node_id IS DISTINCT FROM OLD.node_id) THEN
    RAISE EXCEPTION 'Enrolled/revoked node identity is immutable';
  END IF;
  IF OLD.status='revoked' AND NEW.status<>'revoked' THEN
    RAISE EXCEPTION 'Revoked node ID cannot be reused';
  END IF;
  IF OLD.status='enrolled' AND NEW.status NOT IN ('enrolled','revoked') THEN
    RAISE EXCEPTION 'Enrolled node must not reset enrollment';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vpn_node_enrollment_immutability
  BEFORE UPDATE ON vpn_node_enrollment_inventory
  FOR EACH ROW EXECUTE FUNCTION vpn_node_enrollment_guard_identity();

REVOKE ALL ON vpn_node_enrollment_inventory,vpn_node_enrollment_challenges
  FROM PUBLIC;
REVOKE ALL ON FUNCTION vpn_node_enrollment_guard_identity() FROM PUBLIC;
-- Deliberately no site_auth or unauthenticated web grants for enrollment.
COMMIT;
