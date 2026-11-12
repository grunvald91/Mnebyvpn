# MNEBYDNS — personal DoT canary and hostname rotation

Date: 2026-11-12. **TEST ONLY; production disabled.** Branch PR #122. No operational DNS, payment, proxy, TLS listener, Nginx rules, CoreDNS rules or Android settings are changed by this PR.

## Personal hostname regeneration (implemented for offline canary)

- A verified owner of a paid ACTIVE `smart_dns` entitlement may call the owner-scoped SQL function `rotate_personal_dns_credential(account_id, entitlement_id, expected_revision, new_label, sha256(new_label))` using the strict current revision from `personal_dns_query_status`. Ownership is rechecked with an entitlement row lock **inside** the mutation, not only in the web handler.
- The replacement is 12 random lowercase base36 characters from cryptographic randomness, the same approved format as the original. The previous token digest is replaced atomically; the old hostname cannot authorize paid queries. Open TLS connections must re-check credentials on every DNS question.
- **No extension, credit, quota reset, refund forgiveness or device binding.** Existing per-entitlement query-window usage stays intact, so rotation is not a means to bypass rate limits. Stale expected revisions return `DENY_STALE` and cross-account/inactive credentials return `DENY_INACTIVE`.
- Only SHA-256 of the bearer is stored in PostgreSQL. The new hostname appears once in the authenticated POST response; it is neither a GET URL nor query parameter, and should never enter logs or analytics. A lost hostname requires a fresh replacement; it cannot be recovered.
- Test-only website API: `GET /api/personal-dns/status?entitlementId=<UUID>` and `POST /api/personal-dns/rotate` with JSON `entitlementId`, `expectedRevision`, verified cookie session, same-origin and CSRF token. Enabled only when `MNEBYVPN_ENV=offline-test` and `WEB_PERSONAL_DOT_CANARY_ENABLED=yes` with login. The button remains hidden on production.
- A separately privileged database role is necessary at deployment; **do not grant public access to the SQL function**. A writable/provisioning DB role must have only scoped permissions. A production release requires a full security review, request throttling, audit events and account recovery policy.

## Local DNS-over-TLS canary (implemented; not enabled)

- Source: `packages/dns-policy/src/personal-dot-listener.ts` and `apps/service/src/personal-dot-canary.ts`.
- Runner refuses to start unless `MNEBYVPN_ENV=offline-test` and `MNEBYDNS_PERSONAL_DOT_GATEWAY=canary`. It binds **127.0.0.1:8853**, not public :853, and never modifies a running CoreDNS process.
- Requires an explicitly provisioned TLS wildcard cert whose SAN covers both independent example hostnames under `*.dns.mnebyvpn.site`. The cert and key remain local, not in the repository.
- Length-framed DNS/TCP over TLS: bounds on message sizes (16 KiB), buffered input, queue depth (16) and idle time (30s); bounded local TCP upstream responses with DNS-ID matching. Unknown or rotated labels are rejected even for ordinary domains to prevent an unauthenticated recursive resolver.
- The pure routing policy still uses premium-vs-direct classification and charges only a mapped premium DNS question. Direct questions go to an independent trusted resolver. Expired/quota-exhausted DNS subscription still resolves origin addresses for ordinary internet access; the mapped premium route is not allowed. In case of failure, the canary prefers direct DNS without giving unmetered premium answers.
- Mandatory envs: `MNEBYDNS_CANARY_DATABASE_URL` (disposable DB), `MNEBYDNS_CANARY_TLS_KEY_FILE`, `MNEBYDNS_CANARY_TLS_CERT_FILE`, `MNEBYDNS_CANARY_ROUTE_POLICY_FILE`, `MNEBYDNS_CANARY_ROUTE_POLICY_SHA256`. Optional port settings: `MNEBYDNS_CANARY_PORT=8853`, `MNEBYDNS_CANARY_MAPPED_TCP_PORT=53`, `MNEBYDNS_CANARY_DIRECT_TCP_PORT=5353`.
- The premium-domain file is a JSON array of exact hostnames and `*.suffix` entries extracted from **the currently deployed, reviewed CoreDNS policy**, not a second hand-built production list. Its explicit SHA-256 pin is checked at startup; mismatches fail closed. This does not automatically verify parity with live CoreDNS — manual snapshot provenance and automated drift detection remain release blockers.
- Start only in offline isolated environment: `npm run start:personal-dot-canary`. Never enable ingress/Nginx SNI dispatch or forward production :853 based solely on these tests.

## Necessary before any real customer

1. Integrate trusted payment events (including extra credits, renewals and refunds), account-issued initial key, bot/site status and notifications, with least-privileged database execution and audit logs.
2. Verify real DNS-wire behavior for Android and iPhone: A, AAAA, HTTPS/SVCB, EDNS, pipelined DoT, TLS validation, certificate renewal, cellular versus Wi-Fi, failure scenarios, restarts, reconnection, expired/rotated key. An iPhone profile is a separate deliverable.
3. Verify canonical CoreDNS route policy snapshot and drift detection, independent direct recursive resolver, and measured latency/CPU/DB overhead under representative load. Current canary opens one TCP upstream per question and intentionally prioritizes isolation and simplicity over throughput.
4. **P0: paid proxy bypass remains open.** The shared SNI TCP/443 proxy can be accessed without DNS identity: query accounting is not true HTTPS connection or bandwidth billing. A dedicated paid ingress/ACL design and rollback plan are required.
5. Avoid interruption of currently working free SmartDNS, restore ordinary DNS on proxy failure, and keep production changes behind explicit gates with live canary evidence. No production merge until security and connectivity checks pass.

## Verify

The GitHub workflow runs TypeScript, pure unit tests, disposable Postgres migrations/rollback SQL, and integration tests. Offline TLS tests generate temporary self-signed wildcard material with OpenSSL (never checked into Git). A successful CI verifies repository code, **not** a customer phone, traffic interception, or live DNS/proxy connectivity.


## Code review: DNS response identity and TLS certificate (2026-11-12)

- P1 FIXED (offline canary): before forwarding a DNS response to the client, validate transaction ID, DNS response bit, standard opcode, a single echoed question, canonical QNAME, record type and class. A matching 16-bit DNS ID alone does **not** prove the reply corresponds to the request. The local mapped/direct TCP resolver now rejects mismatched echoes; the premium-policy layer can then use direct DNS when mapped DNS fails. This is **not** a cryptographic DNSSEC validation or a validation of every answer/resource-record section.
- P1 FIXED (offline canary): require the certificate subjectAltName to contain the actual `DNS:*.dns.mnebyvpn.site` wildcard. Checking just two hardcoded sample names is inadequate: a certificate covering only those two names would appear to work but fail for real customers. The regression test supplies exactly those non-wildcard SANs and requires rejection.
- P1 OPEN: a premium DNS quota is debited on authorization, **before** the mapped upstream replies. On mapped failure or TLS disconnect, the request can still consume quota. Do not advertise exact successful-resolution accounting; implement response-aware billing, compensation or explicit documented attempt-based policy with metrics before launch.
- P1 OPEN: without ingress ACL, a client can reach the shared HTTPS proxy directly, bypassing the personal DNS query quota. Neither label rotation nor the token check fixes the 443 proxy bypass.
- P1 OPEN: TLS SNI is bearer material; the 12-symbol label may be observed or shared. Production ingress needs source rate limiting, secret-free logs, credential theft mitigations and real-device validation.
- P1 OPEN: strict Android Private DNS continuity is **not guaranteed** during a PostgreSQL outage. The DoT listener checks `recognize_personal_dns_credential` before every query; if this check errors, it closes the TLS session, including for unrelated ordinary domains. The pure policy core's direct-DNS fallback does not solve this outer-gateway authorization failure. Do not market uninterrupted ordinary internet until tested redundant authorization/DNS ingress or an explicitly bounded safe fallback is implemented.
- P1 OPEN: an old or expired but unrevoked credential remains accepted for direct-only recursion indefinitely because `recognize_personal_dns_credential` checks digest/revoked flag but not expiry. This is intentional to avoid cutting off ordinary DNS after expiry, but it requires measured per-credential/source rate limits, clear time-bounded grace policy and abuse controls before enabling public :853.
- P1 OPEN: actual per-query latency and concurrency remain unmeasured. Every local DNS query currently starts a TCP upstream session; the listener also makes PostgreSQL checks.
- P1 OPEN: the separate draft PR #110/#112 and #122 use alternative `0120` schema filenames/contracts. Reconcile to one migration sequence before any merge or deploy.
