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
