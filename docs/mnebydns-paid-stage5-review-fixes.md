# MNEBYDNS #84 — Stage 5 code review remediation (offline; NOT paid-ready)

This stacked patch applies on top of PR #85 → #86 → #88 → #89. All changes are tested only on disposable PostgreSQL and 127.0.0.1. Production DNS/SNI/VPN, payments and routing are untouched.

## Confirmed fixes

- **FIN/half-close:** Node.js 22's plain `for await (const chunk of socket)` DESTROYS a TCP socket after its readable side ends. The relay now uses `socket.iterator({destroyOnReturn:false})` with `allowHalfOpen:true` on both *relay-owned* sockets. Natural FIN signals `to.end()` but lets the reverse stream drain. Explicit regression test waits for a delayed reply after the client FIN. Abrupt close/error still kills both.
- **Hanging DB:** Every quota call has an application-level watchdog (`quotaTimeoutMs`, default 1.5 s). A promise that never resolves fails closed with no payload forwarded; a stopped/cancelled write with unknown on-wire state retains its HELD reservation rather than claiming 0 bytes. This is not a replacement for production driver/server statement timeouts and cancellation, which remain a release gate.
- **Post-expiry/refund:** `settle_smart_dns_chunk` now records already-issued chunks in an append-only `smart_dns_late_traffic` audit if the ordinary debit denies `DENY_INACTIVE` or `DENY_QUOTA`. It closes the reservation exactly once, preserves both directions, records why normal billing failed and does NOT fabricate a debit against refunded credit. The customer dashboard exposes these bytes as **lateRecordedBytes** and flags reconciliation required. Real merchant settlement policy still needs approval.
- **Privilege separation:** A NOLOGIN `mnebyvpn_dns_ingress` role can execute only `dns_ingress_active`, `dns_ingress_reserve` and `dns_ingress_settle` SECURITY DEFINER wrappers; it receives no direct write access to quota tables. The reserve wrapper validates expected entitlement revision **before** allocation, returns permit and deadline atomically, and stores `granted_revision` with the reservation. Settle checks the ORIGINAL revision even after a refund/revoke.
- **Traffic reports:** `complete` is false while any held or late-unreconciled bytes exist; account ownership is verified by SQL. `monthlyBoundaryBasis=POSTGRESQL_SETTLEMENT_UTC` explicitly indicates these are settlement-time UTC months, NOT packet-time months.
- **SQL roundtrips:** Replaced the old reserve-plus-separate-SELECT with one atomic RPC. Default TCP chunk was raised from 1 KiB to 64 KiB and recheck interval from 200 ms to 1 s. Each chunk still performs DB operations; production p95 throughput, multi-node loads and billing completeness are NOT verified.

## Verification

- Disposable PostgreSQL SQL 0112 contracts: no before-provisioning allocation, exact quota/held cap, stale revision reject, timeout/expiry, refund after reserve, immutable late record, idempotency, ownership isolation and actual NOLOGIN role privileges.
- Actual localhost TCP socket tests: both-direction charging, partial-cap close, mid-connection revocation, missing identity, mocked hard DB outage, never-resolving DB with independent timeout, and delayed response after client FIN.
- These are *loopback* tests, not a public IPv6 or Android Private DNS integration.

## Known release blockers — do not misrepresent as fixed

1. **No proven per-TCP-stream subscriber attribution.** Current RU and foreign VPS have no usable public IPv6: [infra read-only run](https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42793733014). DNS-only queries do not carry a subscriber credential into third-party HTTPS TCP streams. Do NOT expose this relay publicly; the caller-supplied `identity` MUST be replaced by verified ingress routing/credentials and tested with real Android/IPv4-only connections.
2. **Crash recovery for stale HELD chunks remains conservative/fail-closed.** No node-id/epoch/socket-closure proof exists. The API now exposes pending held bytes, but must **never auto-release** them after a timeout: a server crash, DB partition or delayed write might otherwise create double allocation. Safe multi-node fencing and durable recovery/PCAP measurement are still required.
3. **Late-reported bytes are not necessarily charged to a paid quota.** They are transparently separated from charged bytes, so revenue and accounting reconciliation remains outstanding. Merchant refund policy must determine whether/how to reconcile these.
4. **Socket.write callback ≠ remote application receipt.** Network byte definition, TLS/QUIC overhead, true wire captures and month-boundary splitting are still unverified.
5. **Scalability/DB pressure:** even with 64 KiB max chunks, thousands of customers require caching under signed leases, pre-allocated byte budgets, backpressure and p95 benchmarking. No external load or fault-injection (two ingress nodes, partition, restart) was run.
6. **Provisioning heartbeat freshness:** revision and non-null observation are tested, but a real liveness protocol is not implemented. Do not enable `WEB_NETWORK_PROVISIONING_VERIFIED` or `WEB_DNS_METERING_VERIFIED`.

### Safe merge order
Review and merge bottom-up: #85 → #86 → #88 → #89 → this follow-up PR, **only after staging schema/permissions review**. Do not interpret merging this code as authorisation for paid production SmartDNS or DNS rewriting.
