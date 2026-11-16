-- Optional additional VPN nodes; no changes to existing node profiles.
-- Publication requires both operator release flag and independent signed grants.
BEGIN;

CREATE TABLE vpn_additional_nodes (
  node_id text PRIMARY KEY
    CHECK (node_id ~ '^[a-z0-9][a-z0-9-]{2,39}$' AND right(node_id,1)<>'-'),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  country_name_ru text NOT NULL
    CHECK (length(country_name_ru) BETWEEN 2 AND 70
      AND country_name_ru ~ '^[А-Яа-яЁёA-Za-z ()-]+$'),
  endpoint_host text NOT NULL UNIQUE
    CHECK (endpoint_host ~ '^[a-z0-9][a-z0-9.-]{2,250}[a-z0-9]$'
      AND endpoint_host LIKE '%.%' AND endpoint_host NOT LIKE '%..%'
      AND endpoint_host <> 'cdn.servgo.ru'),
  endpoint_port integer NOT NULL CHECK(endpoint_port BETWEEN 1 AND 65535),
  state text NOT NULL DEFAULT 'testing'
    CHECK (state IN ('testing','canary','verified','enabled','degraded','draining','disabled')),
  exit_country_proof_sha256 text NOT NULL CHECK(exit_country_proof_sha256 ~ '^[a-f0-9]{64}$'),
  vpn_e2e_proof_sha256 text NOT NULL CHECK(vpn_e2e_proof_sha256 ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz,
  CHECK (state NOT IN ('verified','enabled') OR verified_at IS NOT NULL)
);

-- Sensitive: VLESS URI is a per-subscriber bearer credential. Only the
-- provisioning writer and the HTTPS subscription reader may access it.
-- The receipt signature is Ed25519 over an exact versioned tuple including
-- the node identity, country, proofs, entitlement UUID, revision and expiry.
CREATE TABLE vpn_additional_node_receipts (
  entitlement_id uuid NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  node_id text NOT NULL REFERENCES vpn_additional_nodes(node_id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000000),
  expires_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  profile_uri text NOT NULL CHECK (length(profile_uri) BETWEEN 80 AND 2048),
  signature text NOT NULL CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  PRIMARY KEY (entitlement_id,node_id)
);
CREATE INDEX vpn_additional_node_receipts_node_idx
  ON vpn_additional_node_receipts(node_id,observed_at DESC);

INSERT INTO vpn_release_flags(feature,enabled)
  VALUES ('vpn_additional_nodes',false)
  ON CONFLICT(feature) DO NOTHING;

REVOKE ALL ON vpn_additional_nodes,vpn_additional_node_receipts FROM PUBLIC;
DO $$
BEGIN
  -- Separate read-only site auth role already reads the living subscription.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
    GRANT SELECT ON public.vpn_additional_nodes,public.vpn_additional_node_receipts,
      public.vpn_release_flags TO mnebyvpn_site_auth;
  END IF;
END $$;
COMMIT;
