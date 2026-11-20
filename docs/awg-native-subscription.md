# FI217 native AmneziaWG 3.1 material (read-only, release OFF)

**Not an AWG reinstallation or a production launch.** FI217 already has a
verified AmneziaWG 3.1 data plane. The existing `/sub/<token>` is a VLESS
base64 subscription used by INCY/Karing. A native `.conf` is a different
protocol and MUST NOT be appended as a fake VLESS line.

New optional endpoint: `GET /awg/<existing-subscription-token>/material?peer=<URL-encoded-X25519-public-key>`.
It uses the **same existing subscription token and current confirmed VPN entitlement (paid or trial)**, and
returns JSON connection material **only** if that exact peer was already
granted, applied on FI and acknowledged to the production controller through
the independently verified signed node receipt.

The endpoint is disabled until `WEB_FI_AWG_MATERIAL_ENABLED=yes` and a
verified, root-controlled `WEB_FI_AWG_HEADER_PROTECTION_KEY` and
independently pinned `WEB_FI_AWG_SERVER_PUBLIC_KEY` are configured.
The canonical PostgreSQL release flag `vpn_awg_clients` must also be true.
There is no automatic flag change, new peer allocation or production launch
in this change.

## Explicit authorization gates

- Existing active `vpn_subscription_links` bearer token resolves to an
  ACTIVE confirmed VPN entitlement (including an authorized 24-hour trial).
  The SQL material query **rechecks** the exact token SHA-256, revoked status,
  current billing state, revision and expiry atomically with the FI grant
  lookup, avoiding a gap after the initial `subscriptionOwner()` check.
- Exact immutable FI217 node and peer identities, enrolled Ed25519 node
  inventory and a server public key matching the independently pinned
  `WEB_FI_AWG_SERVER_PUBLIC_KEY`, not just a database value.
- Fresh verified FI node pool (not `staged`) and `verified_at` within one
  hour of the request. The successful external test is **evidence**, not by
  itself a continuously healthy production pool.
- Exact matching client X25519 public key, unique allocated IPv4/32,
  allocation state `applied`, unexpired local signed lease and current
  billing revision; match latest revision's grant row and command hash.
- Actual node `applied` outbox state with recorded signed ACK digest.
  The signed command itself must still match FI217 node, entitlement,
  exact allocation revision, peer, address and lease expiry.
- The global AWG release feature flag is true. All checks fail closed and
  no read-only website request can sign an Ed25519 command, add a peer, or
  extend a paid expiry.

The JSON contains **no private client key**, controller signing key,
controller SSH key or raw DB credential. Never send the client private key to
this endpoint. `renderLocalAwgConfig(material,privateKey)` is intended for
an on-device/local import flow only; it outputs native AmneziaWG 3.1 `.conf`
with pinned, previously tested FI parameters and `MTU = 1280`.

## Remaining integration before customer launch

The on-device UI must generate an X25519 keypair and locally retain the
private key. An authenticated, controller-only job must register the public
key with `stageAwgGrant` on RU188; its outbox must receive a signed, verified
FI217 ACK. Only then can the read-only endpoint supply material to finish the
client's local `.conf`. The existing FI relay/watchdog/egress must be healthy
and the FI pool must have automatically refreshed verified status.

Do **not** treat this read-only API as client registration, auto-provisioning,
a replacement for an app, a verified Finland subscription entry, or a license
to enable `vpn_awg_clients` or the systemd worker. Existing VLESS lines and
existing clients remain unchanged.

Independent protocol reference:
https://docs.amnezia.org/documentation/instructions/use-amneziawg-app/

## PostgreSQL least-privilege deployment

The existing website subscription reader role `mnebyvpn_sub_ro` must have
`SELECT` on the exact AWG columns in the node pool, enrolled node inventory,
peer allocation, signed outbox and `vpn_release_flags`. The infra installer
`telegram-proxy-infra/scripts/mnebyvpn-subscription-read-role.sh` grants
column-scoped read privileges in one transaction and verifies no UPDATE
privilege. This step makes the API query executable but does not change any
client flag or create a peer. The AWG endpoint remains gated OFF until its
independent production release.
