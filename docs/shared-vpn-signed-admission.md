# DE+FI signed admission V1: staged controller/node wire contract

Status: **controller gateway core implemented; no deployed data-plane enforcement**. Migration 0168 and shared-vpn-admission-controller.ts connect the crypto ABI to restricted PostgreSQL RPCs. Nothing listens on a port, edits Xray/AWG, starts a worker or changes the paid profiles.

- One purchased entitlement, one HTTPS subscription, both profiles named
  **MNEBYVPN Германия** and **MNEBYVPN Финляндия** after their own verified
  grants. The same *immutable* \`order_terms.device_limit\` governs both.
- The authoritative RU188 DB ledger is
  \`db/migrations/0147_vpn_shared_connection_leases.sql\`, gated OFF by default.
  Its atomic lock enforces the cap **if and only if** the real data plane
  invokes it for every new active session; that condition is NOT met.
- \`shared-vpn-admission-protocol.ts\` specifies pinned Ed25519 request
  signatures, operation/entitlement/connection/peer/country binding, strict
  timestamps and a domain-separated signed controller decision. The node's
  private key never belongs to RU188. A node must independently pin RU188's
  verification key. Signed positive decisions carry local expiry <=45 seconds.
- This ABI **does not** authenticate the actual VPN transport and does not
  prove that the peer belongs to an entitlement; the gate worker must verify
  an independently signed and acknowledged peer grant. Raw node requests
  must NOT be forwarded to a generic SQL role.
- Every received \`nonce\` must be inserted into a **durable unique
  database registry** before any claim/heartbeat/release. The 15-second
  signature freshness check is not replay protection. The existing 0147 SQL
  RPCs do not implement this and must stay unavailable to unverified callers.
- The decision is sent only AFTER a serialized RU188 DB transaction and
  signed with a controller key inaccessible to clients, nodes and GitHub
  Actions. Network timeouts and unknown results are not successful grants.
- German Xray VLESS online stats and Finnish AWG last handshake are NOT
  pre-acceptance hooks. A signed controller response is **still not**
  enforcement until a local transport gate prevents unadmitted sessions,
  refreshes and locally removes expired sessions, handles controller loss,
  and passes external concurrent DE+FI E2E. Existing live traffic stays
  untouched in this stage.

Tests: real Ed25519 DE/FI cross-signature rejection, tampering, stale
requests/decisions, mismatched request hashes, lease lifetime, revoked/denied
credentials, strict extra-field validation. They are not live connection tests.


## Controller integration (trial final review follow-up)

- Migration 0168 adds a scoped node identity lookup and an atomic decision RPC returning the actual ledger deadline, bounded by the peer grant, plus duplicate claim rejection. The controller library verifies the pinned Ed25519 envelope before mutation and signs only the returned committed result. Its database connection must be dedicated to the controller; do not pass an open caller-managed transaction.
- This is not a running gateway. Remaining: privately authenticate and expose the controller endpoint; verify real independent peer receipts and populate bindings (no broad writer privileges); implement transport-specific local admission and fail-closed lease expiration in DE and FI; prove device/session semantics for VLESS multiplexing and AWG key reuse. A VLESS TCP stream or an AWG recent handshake is not itself a device identity. Never enable the global flag or claim one-device enforcement until live tests pass. Existing paid profiles remain untouched.
- Test the SQL boundary on disposable PostgreSQL and the TypeScript signer with generated keys. Deploy only after independent review and real two-client tests, including country switching, controller outage, and expiry.
