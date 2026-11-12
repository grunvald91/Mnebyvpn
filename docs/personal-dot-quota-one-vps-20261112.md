# MNEBYDNS personal DoT quota — one existing foreign VPS

**Status 2026-11-12: offline database and token tests PASS; no production DoT ingress / paid access enabled.**

## Contract

- A customer receives a random **DoT hostname**, not an HTTPS URL: e.g. `k7m4p9x2c6qa.dns.mnebyvpn.site` (example only). The bearer label has **exactly 12 symbols** from `0-9a-z` (36^12 = 4,738,381,338,321,616,896 combinations, ~62 bits of online guessing space), and is sampled without modulo bias from a 128-bit CSPRNG. No user/device identifier is encoded. The 128-bit **random input** is not the 62-bit **output strength**.
- A hostname represents a **transferable bearer capability**, not a password bound to a person or phone. It can be copied to another device and its TLS SNI may be visible to an on-path observer. The 12-character format needs actual gateway-side per-source throttling, strict request limits, security monitoring and a tested reissue/revocation workflow *before launch*. Do not claim CSPRNG entropy protects against a leaked SNI. Devices with the same hostname share one budget.
- The new canary counter measures **validated successful upstream premium DNS answers**, not HTTPS connections, unique apps, watched video streams, devices, traffic bytes, or cached lookups. One DNS query may precede hundreds of HTTPS connections.
- Initial engineering policy is **1,000,000 validated premium upstream DNS answers per fixed 30-day period**. This is a trial configuration, NOT a validated heavy-use fair limit. Real measurements from phone (Wi-Fi and mobile data) are still needed.
- Window 0 begins at the entitlement's `starts_at`; new 30-day window starts only on elapsed time, **not** on every renewal. Termination at `expires_at` is independent. Customer can see counter and next reset from `personal_dns_query_status(entitlement_id)` once ownership checking is integrated into the cabinet/bot.
- `issue_personal_dns_credential` is idempotent on a still-known entitlement; no credential reuse across subscribers. Only SHA-256 of the bearer label is retained in PostgreSQL; the plaintext label is shown once at issuance and cannot be recovered from the database.
- `consume_personal_dns_query` locks the entitlement and atomically increments the active 30-day window. It returns `ALLOWED`, `DENY_QUOTA`, `DENY_INACTIVE`, `DENY_UNKNOWN`, `DENY_INVALID`. The legacy attempt-metering SQL helper remains for offline contract compatibility. The new canary instead uses `reserve_personal_dns_query(label, uuid)` before upstream forwarding and `finish_personal_dns_query(uuid, true/false)` after a validated upstream response or failure. It must obtain `SETTLED` before returning a SmartDNS-mapped answer. It cannot infer a customer's identity from ordinary DNS request QNAME or their public IPv4 alone.
- `revoke_personal_dns_credential` permanently marks the credential revoked. Active subscription update and revocation use the same entitlement row lock. A second device with the copied hostname cannot bypass the shared budget.

## Crucial consumer behavior at quota expiry

A DNS quota must never break ordinary Internet access on a phone configured to use strict Private DNS. A future gateway should distinguish:
- **premium SmartDNS route**: only after a reserved query and successful settlement, pass to the existing CoreDNS mapping/foreign SNI proxy;
- **ordinary direct domain**: always resolve normally without charging a premium unit;
- **premium route after `DENY_QUOTA` / expiry**: use an independent trusted upstream resolver for the **real origin address**, not the CoreDNS SmartDNS mapping, and notify the subscriber in Telegram/cabinet to renew. No DNS-redirect-to-checkout: that would cause TLS certificate errors.
- **backend unavailable**: no paid/proxy answer without authorization. Design ordinary-resolution continuity and per-source rate limiting before launch.

The route classifier must reuse the **authoritative deployed CoreDNS policy** or a tested shared config. Do not maintain an independent hardcoded service list that silently drifts.

## Outstanding production engineering

1. Issue wildcard DNS `*.dns.mnebyvpn.site` to the existing VPS, with valid wildcard TLS certificate and DNS record(s); verify Android connects using the unique DoT hostname. **Not configured.**
2. Stage the SNI-terminating DoT gateway on **127.0.0.1:8853** on the same foreign VPS; it must validate TLS/SNI, parse length-framed DNS/TCP, limit buffers and concurrent sessions, look up the entitlement and charge proxy-route DNS messages, preserve normal DNS for all other domains. Probe under load.
3. The existing CoreDNS owns TCP 853. Moving the public 853 entry point requires explicit coexistence/rollback planning; **do not touch** currently working CoreDNS and Nginx before tested canary.
4. **Critical:** the existing shared IPv4 443 SNI proxy may be accessible directly without consulting DNS. Counting DoT queries does NOT enforce paid proxy access or prevent bypass via direct IP / cached DNS. Need a separate ingress control/migration strategy without breaking free existing services.
5. Integrate credential issuance and status with the actual paid subscription, authenticated website/Telegram account, bot notifications (e.g. 80/95/100%), renewal and refund logic. No arbitrary unauthenticated lookup by entitlement UUID.
6. Test query-level billing for `A`, `AAAA`, `HTTPS/SVCB`, DNS caching, concurrent requests, multiple devices sharing a link, expired periods, two networks, slow PostgreSQL, and full VPS restart.
7. **Early repurchase top-up is not implemented yet.** The current fixed 30-day counter does not reset when a buyer purchases an early renewal, because verified billing extends expiry in the existing entitlement. This would contradict the proposed “pay again to resume now” behavior. Before opening sales, add an atomic **per-verified-order query credit grant**, preserving previous usage and refund correctness; cover repeat payment events and concurrent purchases. Do not assume the current code resumes access immediately after a new payment.
8. Decide published billing policy only **after observing real consumption**; one million queries is not a guaranteed estimate of heavy-use demand.

## Release evidence

- Migration: `db/migrations/0120_personal_dot_query_quota.sql`.
- Rollback-only SQL contract: `db/tests/0120_personal_dot_query_quota_contract.sql`.
- Concurrent real PostgreSQL calls: `tests/integration/personal-dot-query-quota.test.ts`.
- Identity generator: `packages/dns-policy/src/personal-dot-identity.ts`.
- DoT routing policy core: `packages/dns-policy/src/personal-dot-gateway-core.ts` (pure functions, **no network listener**, validates DNS question/identity, preserves ordinary DNS and directs exhausted premium requests to a trusted direct resolver); tests: `tests/personal-dot-gateway-core.test.ts`.
- Quota status function `personal_dns_query_status` returns active/expired/exhausted status, remaining messages and next reset. No public user API exists; owner authentication still required.
- Latest successful post-review test: https://github.com/grunvald91/Mnebyvpn/actions/runs/43298361949 (209/209 Node unit tests, 66/66 PostgreSQL integration tests, plus migration and rollback SQL checks).
- Existing CoreDNS is configured on the foreign VPS (separate infrastructure repo); this PR changes **no production service**.

The DNS-only query-metering model is preferable to /64 for issuing per-hostname profiles, **but it does not solve the original full HTTPS traffic authorization requirement**. Never turn on paid sales just because the database counter passes tests.

## Code review 2026-11-12: fixes and outstanding design gaps

- **Fixed:** Excessive 27-character legacy identifier replaced with 12-base36 uniform random label across parser, SQL schema, unit/DB fixtures and gateway tests. Generated output contains ~62 bits, not 128 bits; do not conflate source entropy with label strength.
- **Fixed:** SQL provisioner now checks the SHA-256 label digest instead of accepting any caller-supplied hash, and refuses a different credential for an existing entitlement or revival of an explicitly revoked credential.
- **Fixed:** DNS wire parser now rejects ambiguous/trailing/malformed DNS records while accepting a single bounded EDNS0 OPT record. This helps prevent classifier/resolver disagreement. An isolated local TLS DoT listener exists; no public production DoT endpoint is deployed.
- **Fixed:** Found a damaged and accidentally duplicated SQL migration generated during the identifier refactor. Restored a single transaction containing each function once; the disposable PostgreSQL suite is green.
- **Still open / P1:** Issuance/consumption functions are only database primitives; no live DoT SNI client accounting, wildcard DNS/TLS or proxy bypass enforcement exists.
- **Still open / P1:** An early paid renewal extends entitlement expiry but **does not immediately add query budget to the current window**. Add a verified-payment idempotent credit ledger with refund semantics and integration tests before advertising 'pay again and immediately reconnect'.
- **Still open / P1:** Counter represents DNS questions, not HTTPS connections. No verified estimate of a single heavy-use phone's real DNS demand, and has basic per-label in-memory rate limiting, but not a verified public gateway throttle. Private DNS needs to preserve access to ordinary sites even after paid quota is depleted.


## Post-review DNS availability and secret-storage hardening

- If the route classifier or mapped SmartDNS resolver fails, the pure gateway policy falls back to the trusted direct DNS resolver rather than breaking ordinary Android Private DNS. The listener now reserves and releases quota on mapped resolver failure; handset delivery after successful upstream settlement is still not guaranteed.
- The credential table stores **only the SHA-256 digest**. The bearer label is not persisted and is no longer returned by the quota-status function. Account recovery/reissue of a lost label still needs a secure authenticated design; do not promise it in the UI yet.


## Revision 2026-11-12: reservation-ledger canary

- A premium message allocates one bounded SQL reservation. Concurrent reservations count against the limit. Valid upstream response (matching DNS ID, QNAME, QTYPE and QCLASS) must be settled **before** mapping is returned. Failed upstream resolution releases the reserved slot; a stranded reservation expires after 15 seconds and is reclaimed. This counts successful upstream DNS answers, not TLS packets delivered to a device.
- The primary canary uses `resolvePersonalDnsWithSettlement`; the older `consume_personal_dns_query` helper is retained only for earlier database contracts, **not** for the active listener.
- Verified bearer identities are cached by digest for at most 90 seconds solely for a **direct-only** short PostgreSQL outage fallback. No unbilled premium access is possible from this cache. Newly connected customers after cold restart or expiration of the cache may lose strict Private DNS until PostgreSQL recovers.
- Expired unrevoked subscriptions may use direct-only recursion for seven days, after which the key is denied (strict Private DNS needs fallback/replacement). Per-label token bucket permits up to 30 queries/sec, burst 60, with 128 total TLS sessions and 8 sessions per bearer credential; separate handshake and source-IP protections are still required before a public Nginx stream ingress.
- Test evidence: `tests/integration/personal-dot-settlement.test.ts`, `tests/personal-dot-settlement-core.test.ts`, `tests/personal-dot-listener.test.ts`. This does not imply a successful phone or production test. Other draft PRs #110 and #112 must not be merged into the same schema path without reconciliation.
