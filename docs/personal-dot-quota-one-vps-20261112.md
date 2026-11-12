# MNEBYDNS personal DoT quota — one existing foreign VPS

**Status 2026-11-12: offline database and token tests PASS; no production DoT ingress / paid access enabled.**

## Contract

- A customer receives a random **DoT hostname**, not an HTTPS URL: e.g. `d<26 base32 symbols>.dns.mnebyvpn.site`. Android Private DNS accepts a hostname. The hostname is 128-bit random; no phone/device identifier is embedded.
- A hostname represents a **transferable bearer capability**: it can be copied to another device and its SNI may be visible to an on-path observer. Do not describe this as hardware-bound authentication. A recipient who copies it shares the **same** quota.
- The counter measures **DNS messages accepted by a personal DoT ingress**, not HTTPS connections, unique apps, watched video streams, devices, traffic bytes, or cached lookups. One DNS query may precede hundreds of HTTPS connections.
- Initial engineering policy is **1,000,000 accepted DNS messages per fixed 30-day period**. This is a trial configuration, NOT a validated heavy-use fair limit. Real measurements from phone (Wi-Fi and mobile data) are still needed.
- Window 0 begins at the entitlement's `starts_at`; new 30-day window starts only on elapsed time, **not** on every renewal. Termination at `expires_at` is independent. Customer can see counter and next reset from `personal_dns_query_status(entitlement_id)` once ownership checking is integrated into the cabinet/bot.
- `issue_personal_dns_credential` is idempotent on a still-known entitlement; no credential reuse across subscribers. The label and its hash are recorded in PostgreSQL.
- `consume_personal_dns_query` locks the entitlement and atomically increments the active 30-day window. It returns `ALLOWED`, `DENY_QUOTA`, `DENY_INACTIVE`, `DENY_UNKNOWN`, `DENY_INVALID`. A real gateway MUST call it once per accepted premium DNS message and must wait for `ALLOWED` **before** returning a SmartDNS-mapped answer. It cannot infer a customer's identity from ordinary DNS request QNAME or their public IPv4 alone.
- `revoke_personal_dns_credential` permanently marks the credential revoked. Active subscription update and revocation use the same entitlement row lock. A second device with the copied hostname cannot bypass the shared budget.

## Crucial consumer behavior at quota expiry

A DNS quota must never break ordinary Internet access on a phone configured to use strict Private DNS. A future gateway should distinguish:
- **premium SmartDNS route**: while `ALLOWED`, pass to the existing CoreDNS mapping/foreign SNI proxy;
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
7. Decide published billing policy only **after observing real consumption**; one million queries is not a guaranteed estimate of heavy-use demand.

## Release evidence

- Migration: `db/migrations/0120_personal_dot_query_quota.sql`.
- Rollback-only SQL contract: `db/tests/0120_personal_dot_query_quota_contract.sql`.
- Concurrent real PostgreSQL calls: `tests/integration/personal-dot-query-quota.test.ts`.
- Identity generator: `packages/dns-policy/src/personal-dot-identity.ts`.
- Latest successful test: https://github.com/grunvald91/Mnebyvpn/actions/runs/43291495076
- Existing CoreDNS is configured on the foreign VPS (separate infrastructure repo); this PR changes **no production service**.

The DNS-only query-metering model is preferable to /64 for issuing per-hostname profiles, **but it does not solve the original full HTTPS traffic authorization requirement**. Never turn on paid sales just because the database counter passes tests.
