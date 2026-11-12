# MNEBYDNS paid IPv6 on the EXISTING foreign VPS: release blockers and evidence
Date: 2026-11-12

**Owner scope:** one existing foreign VPS only, current IPv4 service remains unchanged. No new VPS, no other DNS/proxy server, no paid IP purchase without owner approval. Source and tests in PR #111 are OFFLINE, NOT PRODUCTION READY. Do not enable paid DNS products from these tests.

## Provider / network status

- The activation email for VPS "First030526" at foreign IPv4 89.125.90.101 identifies the seller/customer portal as **AdminVPS**. ASN IP prefix 89.125.90.0/24 is announced from AS57043 HOSTKEY; the network operator is **not** proof of which company sold or manages the VPS. Never disclose activation email credentials or private server access.
- Prior read-only IPv6 inspection on the FOREIGN node found kernel IPv6 enabled but **no public IPv6 assigned, no IPv6 default route and no publicly delegated/routed /64 confirmed**. Read-only evidence: https://github.com/grunvald91/telegram-proxy-infra/actions/runs/43163952073.
- AdminVPS public offers do not provide a verified /64 for *this actual account and VPS*. Listings about IPv6 conflict; authoritative answer requires an AdminVPS support ticket or sales confirmation for exactly this server. No payment/changes have been made.
- A request for details is staged as an **unsent Gmail draft**; no support ticket has been opened.

## Completed OFFLINE code in this PR

- Candidate IPv6 address derivation based on provider-verified global /64 + entitlement UUID + 32-byte secret. This is **not** an allocated address and not an authentication decision; final immutable binding uses the permanent DB registry.
- Mandatory SQL verified-prefix register before *any* claim succeeds. Prefixes default to disabled and require separately recorded provider confirmation + external route probe. Tests use synthetic global-looking test addresses, not a real allocation.
- Immutable IPv6 SQL claims: destination, entitlement and original timestamp cannot be changed, rows cannot be deleted/truncated, retirement is one-way. No cross-subscription reuse.
- SNI ingress policy denies unknown destination IPv6, expired/refunded/inactive/retired/exhausted entitlements, missing/ECH SNI or unapproved exact SNI. No wildcard targets.
- Isolated per-block debit-before-forwarding (16 KiB maximum per debit); backend must use existing PostgreSQL function debit_smart_dns_quota() with entitlement row lock. Unknown/timeout/debit reject closes the stream, never forwards unbilled bytes. This proves an **accounting policy prototype**, not a performant packet relay.
- Sales activation has **one operator configuration key**: `MNEBYDNS_PAID_SALES_ENABLED=yes` (plus the existing ordinary payment/login settings). The previous nine additional paid-DNS attestation flags were removed at the owner's request. Website catalogue/checkout/trials and shared website/Telegram billing store read this same switch. Network readiness cannot be manufactured by setting it.
- Disposable PostgreSQL tests and Node tests; zero production routes, secrets, DHCP, Nginx, CoreDNS, VPS or firewall modifications.

## Blocking technical gaps before REAL sales

1. **Provider-routed IPv6**: written confirmation for this exact AdminVPS VPS; prefix/gateway/NDP routing; free/paid price, maximum address limits, external TCP 443 and IPv4 rollback. A single /128 is insufficient for distinct-address-per-entitlement approach.
2. **End-user IPv4-only coverage**: IPv6-only ingress cannot work from a genuinely IPv4-only customer network without a proven compatibility transport. An IPv4 *shared* address is NOT a secure per-subscription fallback.
3. **Legacy shared IPv4 bypass**: existing SmartDNS shared IPv4 SNI pass-through may allow the same proxied domains without any paid identity/quota. It must be isolated or access controlled with proven no-disruption migration. Never silently disable working IPv4 production paths.
4. **Real per-user DNS resolver**: Android Private DNS expects DoT hostname, not a personalized DoH URL. Need per-account authenticated DoT hostname/TLS-SNI if supported + validated wildcard certificate, or a tested alternative UX; separate iOS/macOS signed/verified install/uninstall profiles. Existing CoreDNS public DoT isn't user-auth.
5. **Working paid ingress listener**: link TCP IPv6 destination address to immutable claims, parse bounded fragmented TLS ClientHello securely, enforce allowlisted SNI/anti-SSRF, build upstream connection using DNS **without recursive local rewrite**, relay full TLS in both directions, cap concurrency and buffer. The current PR does not implement or bind such a listener.
6. **Fast and correct quota/settlement**: the proof debits 16 KiB before each forward. This can cause high per-chunk DB latency and charge attempted-but-unsent bytes. Before selling: implement *atomic* preallocation/settlement with crash recovery, concurrent streams, bounded overshoot and exact billing definition; benchmark p50/p95 against today's service.
7. **Revoke and expiry with live sockets**: prove immediate new-connect deny even with cached DNS/direct IPv6, define and test cutoff for already-open sockets, test outage of control plane (new traffic fail closed) and repeat/refund race conditions.
8. **Release E2E**: original HTTP certificate unchanged; ordinary websites remain direct; Android and Apple tests Wi-Fi/mobile, IPv6-only/IPv4-only, ECH/QUIC/HTTP3 fallback, captive portals, DNSSEC and HTTPS/SVCB; operator rollback and staged customer pilot. Site/payment legal requirements and actual provider payment confirmation still apply.

### Explicit release decision

Status: **CODED_OFFLINE / PAID_SMART_DNS_BLOCKED**. Paid DNS prices can be prepared but are not saleable until the single operator switch is turned on. **Do not turn it on before the missing transport is implemented**; it is a sales switch, not a mechanism capable of providing a working paid ingress. The paid website/bot must never grant an entitlement whose ingress is unverified. Never infer paid readiness from a green CI alone. All server/network/provider changes require a separate verified rollout with snapshots and rollback.

References:
- https://www.rfc-editor.org/rfc/rfc7858 (DNS over TLS)
- https://www.rfc-editor.org/rfc/rfc8484 (DNS over HTTPS)
- https://www.rfc-editor.org/rfc/rfc6066 (TLS SNI)
- https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html
- https://adminvps.ru/ (seller and support information)
