-- Reliable two-phase delivery for signed AmneziaWG peer commands.
-- A queued command is NOT an applied VPN grant. The controller must never
-- publish a subscription based solely on the existence of this record.
BEGIN;

CREATE TABLE vpn_awg_command_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id text NOT NULL,
  entitlement_id uuid NOT NULL,
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
  CHECK(expires_delivery_at > issued_at),
  CHECK(expires_delivery_at <= issued_at + interval '40 seconds'),
  CHECK((op='grant' AND billing_revision IS NOT NULL) OR
        (op='revoke' AND billing_revision IS NULL)),
  CHECK((state <> 'applied' OR
         (applied_at IS NOT NULL AND node_receipt_sha256 IS NOT NULL))),
  CHECK((state <> 'claimed' OR claimed_at IS NOT NULL)),
  FOREIGN KEY(node_id,entitlement_id)
    REFERENCES vpn_awg_peer_allocations(node_id,entitlement_id)
    ON DELETE CASCADE,
  UNIQUE(node_id,entitlement_id,revision)
);
CREATE INDEX vpn_awg_outbox_pending_idx
  ON vpn_awg_command_outbox(state,issued_at)
  WHERE state IN ('queued','claimed');
REVOKE ALL ON vpn_awg_command_outbox FROM PUBLIC;

-- A revocation record never permits a new grant by accident. The caller
-- checks both the current entitlement revision and node release gate.
COMMIT;
