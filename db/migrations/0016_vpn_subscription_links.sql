BEGIN;

-- Opaque HTTPS VPN subscription bearer links. The database stores SHA-256
-- digests only. The subscriber credential itself is held by the Xray node
-- and is never placed in this table.
CREATE TABLE IF NOT EXISTS vpn_subscription_links (
  token_sha256 text PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  entitlement_id uuid NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS vpn_subscription_links_entitlement_idx
  ON vpn_subscription_links(entitlement_id,created_at DESC);

COMMIT;
