-- Additive multi-node control-plane metadata. Not connected to live traffic.
-- No credentials, subscriber URLs, public routing or automatic provisioning.
BEGIN;

CREATE TABLE vpn_nodes (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9-]{2,48}$'),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  kind text NOT NULL DEFAULT 'normal'
    CHECK (kind IN ('normal','regional','special')),
  state text NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned','testing','canary','verified','degraded','draining','disabled')),
  capabilities text[] NOT NULL DEFAULT '{}'::text[],
  max_clients integer CHECK (max_clients IS NULL OR max_clients > 0),
  -- Private control endpoint is NOT a public subscription URL; no secrets here.
  control_url text,
  client_host text,
  client_port integer CHECK (client_port BETWEEN 1 AND 65535),
  verified_at timestamptz,
  verification_report_sha256 text CHECK (
    verification_report_sha256 IS NULL OR
    verification_report_sha256 ~ '^[a-f0-9]{64}$'),
  operator_approved_at timestamptz,
  enabled_for_new boolean NOT NULL DEFAULT false,
  last_probe_at timestamptz,
  last_probe_ok boolean NOT NULL DEFAULT false,
  last_healthy_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (array_position(capabilities, NULL) IS NULL),
  CHECK (state <> 'verified' OR
    (verified_at IS NOT NULL AND verification_report_sha256 IS NOT NULL
      AND operator_approved_at IS NOT NULL)),
  CHECK (NOT enabled_for_new OR state = 'verified')
);

-- "pending" is only an allocation intent. It does NOT grant network access.
-- Real node-revision acknowledgements must be implemented before activation.
CREATE TABLE vpn_node_assignments (
  entitlement_id uuid NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  node_id uuid NOT NULL REFERENCES vpn_nodes(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','active','revoking','revoked','failed')),
  desired_revision bigint NOT NULL CHECK (desired_revision >= 0),
  applied_revision bigint NOT NULL DEFAULT 0
    CHECK (applied_revision >= 0 AND applied_revision <= desired_revision),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (entitlement_id, node_id)
);
CREATE INDEX vpn_node_assignments_node_state_idx
  ON vpn_node_assignments (node_id, state);
CREATE INDEX vpn_nodes_new_candidates_idx
  ON vpn_nodes (state, enabled_for_new, last_healthy_at);

COMMIT;
