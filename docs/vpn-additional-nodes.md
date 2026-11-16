# Multi-node VPN subscription read path (2026-11-17)

## Scope

**Staged and disabled by default; not a claim that extra VPS are provisioned or that production subscribers can select new countries.** This change makes the current subscription URL capable of *reading and appending* verified additional VPN nodes when a separate node registrar/provisioner has already registered and proved each node and each subscriber's access.

The legacy /sub/<token> path and the existing hard-expiring Xray profile are left intact. Old Reality and WebSocket lines remain in their existing order, even when an additional-node table or signature is unavailable. An offline test covers both INCY and Karing client URL variants.

## Publication requires all four conditions

1. The new VPS is independently enrolled, its actual VPN egress country is verified, and the node is healthy (fresh <= 1h E2E and country evidence) with state `enabled`. Country labels originate from approved server metadata, not IP geolocation guesses in the request path.
2. The *specific subscriber* has an active, provisioned entitlement in the existing canonical PostgreSQL database, with a node-verified profile and exact revision and expiry. New node grants must be refreshed within 15 minutes.
3. The node registrar signs the exact canonical payload for that subscriber and node with a dedicated Ed25519 private key. The public website has only an Ed25519 verification key; the private key must never be in Git, GitHub Actions logs, the website, or an LLM request.
4. **Both** the website variable `VPN_ADDITIONAL_NODES_ENABLED=yes` and the database feature `vpn_release_flags.feature='vpn_additional_nodes',enabled=true` are enabled, after real client E2E, expiration/revocation testing and a rollback readiness review. Both default off. Do not enable them with an empty registry and assume the new servers are working.

New SQL tables: `vpn_additional_nodes` and `vpn_additional_node_receipts` from migration 0127. Receipts contain confidential VLESS access URIs and require a least-privilege DB reader and isolated writer. Only a verified active receipt is published, not merely a record in the node table. Unknown or stale rows are skipped, preserving the legacy profile.

## Signer implementation contract

Use the exact serialization exported by `additionalNodeReceiptPayload` from `packages/provisioning/src/multi-node-subscriptions.ts`, sign it with Ed25519 (Node.js `sign(null, payload, privateKey)`) and store the base64url signature in the restricted receipt table. Receipt metadata and the exact URI, including endpoint hostname, port, verified country, E2E evidence hashes, entitlement UUID, current revision, expiry and observation timestamp, are all covered. The URL must be VLESS/REALITY/TCP/Vision with validated SNI, public key and short ID. The reader ignores unverified or broken rows.

The node provisioner must independently *prove* that the subscriber exists and expires on each added node, and continuously reconcile revocations, renewals and expired subscriptions. This PR contains **no auto-signer, enrollment authority, E2E probe collector or extra VPS installer**. It is deliberately impossible to produce live multi-node entries without a trusted signer and successful provisioning. Never copy existing Xray/WireGuard private keys into a new node.

## Future implementation in order

1. Build signed enrollment and per-node identity issuance within the nodekit provisioner; store trusted country/E2E evidence in the registry.
2. Implement a private controller that allocates each ACTIVE entitlement to confirmed nodes, issues node-local grants and signed receipts, and synchronizes renewals, revocations and hard expiry per node.
3. Validate real VPN end-to-end from distinct client networks, including Karing and INCY country-labelled entries; only then enable the two flags.
4. Connect periodic multi-vantage monitoring and AI incident escalation to the same controller. Agent permissions must remain restricted to documented runbooks, with owner approval for global changes.

## CI and rollback

`offline-contracts.yml` applies migration 0127 and exercises DB contract + integration subscription refresh. Disabling either flag immediately stops appending extra profiles on future refresh without changing existing subscriber URLs. This does **not** revoke VPN credentials already cached on clients: the per-node provisioner must enforce revocation and expiry at the actual node. Reverting only the website is not a secure substitute for disabling access on all added nodes.

Source context: [Nodekit architecture](https://github.com/grunvald91/telegram-proxy-infra/blob/main/nodekit/OPERATIONS.md) and `docs/vpn-transport-subscription-policy.md`.
