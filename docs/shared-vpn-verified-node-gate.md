# MNEBYVPN: signed DE+FI admission database gate (0148)

Status: **staged, default-OFF**. It does not enforce the limit on live Germany
VLESS or Finland AmneziaWG and does not modify the existing clients.

RU188 receives a *signed* request defined in
`packages/provisioning/src/shared-vpn-admission-protocol.ts`.
The currently absent trusted RU188 gateway must independently pin and verify
the requesting DE/FI node's Ed25519 public identity and enforce the 15-second
freshness window BEFORE calling private `vpn_shared_connection_verified_apply`.
The database function itself cannot verify Ed25519; never expose it directly
to the internet, network nodes, the public website or Telegram bot.

On first verified node grant/ACK, a future privileged writer may register
the exact entitlement revision + per-node peer hash and signed grant receipt
digest in `vpn_shared_connection_authorized_peers`. Nothing is populated
by the migration, and **no SQL write permission is granted to the admission
role**. A registered peer is not evidence of an active connection.

Each signed request carries a random 256-bit nonce and a digest of the exact
signed payload. The private SQL function records its `(node_id,nonce)`
before checking grant status, so a denied request cannot later be replayed
as accepted. A heartbeat cannot create a new session. One entitlement lock
serializes Germany and Finland before the existing 0147 global count.
Release still works after refund or while the feature flag is disabled.
Direct V1 claim/release execute rights are revoked from the admission role.

**Retention:** currently no automated nonce cleanup. A future restricted
janitor can prune rows older than two minutes, never within the protocol's
15-second signature window. Rate limits and storage quotas for signed
requests must be specified before production enablement.

**Remaining work / BLOCKED:** live signed request gateway, authorization of
grant receipts from existing node-ACKs, independent DE enrollment, connection
identity acquisition at the data plane, local enforcement hooks on both VPN
protocols, controller loss fail-close, revocation and cross-country 1/2/3/4
concurrent E2E. Neither Xray online stats nor AWG latest-handshake is a
before-connect admission hook. No existing peer or customer config changed.
