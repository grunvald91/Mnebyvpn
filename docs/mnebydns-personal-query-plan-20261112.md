# MNEBYDNS — personal DNS links and paid query allowance
Date: 2026-11-12. **Only control-plane code and offline tests; no personal DNS resolver has been deployed.**

## One foreign VPS and no IPv6 purchase

Use only the existing foreign VPS for the SmartDNS ingress. No new VPS or delegated IPv6 subnet.

A paid DNS entitlement has one stable personal credential:
- Android Private DNS hostname: p-<32 lowercase base32 chars>.dns.mnebyvpn.site (DoT on 853).
- iOS/macOS personal DoH URL: https://dns.mnebyvpn.site/dns-query/p-<the same 32 chars> (delivered through a verified device DNS profile).
- Credentials come from 160 bits of HMAC output based on account entitlement, revision and an operator-held 32-byte key. The canonical database stores the SHA-256 digest of the credential, not the raw link. The key must be kept stable across deploys.
- Renewing the SAME entitlement extends its available credits without replacing its personal link. Purchasing a separate new entitlement creates a separate link.

A wildcard DNS A record for the personal hostname, a trusted TLS certificate covering *.dns.mnebyvpn.site and a real per-person DoT/DoH ingress gateway are required before links work. None is installed in this PR.

## Fair-use product: exactly what is counted

**One successfully proxied DNS A lookup for an exact supported hostname = one quota unit.**

- The gateway must consult the deployed SmartDNS route list (not a second hard-coded set of unrelated domains). Only names mapped to the foreign proxy address and actually answerable count.
- Ordinary direct DNS lookups, banks, Yandex and other sites DO NOT consume a unit. Neither do unrelated background DNS queries or RR types the SmartDNS service does not rewrite.
- A one-million-query allowance is initially attached to every separately verified, nonrefunded paid credit. For a 30-day plan, it equals approximately 33,333 proxied lookups/day (about 23.1 per minute). This is a product choice, **not** evidence of typical real-world demand. Observe anonymous aggregate usage for 7–14 days in a pilot before tightening any cap.
- Cache reuse, DNS client retries and browser-owned resolvers mean DNS queries do NOT equal HTTPS sessions, videos watched, total gigabytes or devices. One link can be shared with multiple devices. It is a bearer capability, not device-bound authentication.
- On exhaustion, the gateway should return the ordinary direct DNS answer for a previously proxied hostname, NOT a fake paywall and NOT a device-wide DNS failure. Existing cached proxy answers and direct TCP access to shared IPv4 remain possible, so this is NOT a hard byte or connection cap.
- A paid renewal to the same entitlement adds another 1,000,000 units, leaves already used queries charged, and keeps the same link. Refund removes the corresponding quota credit. Customer cabinet shows the remaining query allowance and offers renewal.

## Implemented in the PR

- Secure deterministic generation/format validation of personal DoT hostnames and DoH URLs.
- Hash-only credential registry, canonical entitlement ownership checks, serializable row-locked atomic per-proxied-query decrement, balance and paid-credit rollover using existing entitlements, orders and entitlement_credits.
- Owner-authenticated personal DNS endpoint on the website; no-store secret URL response and no client secret stored in database.
- Customer UI displays the personal link and actual query allowance, without representing old DNS byte quotas as measured DNS requests.
- Disposable PostgreSQL and unit tests of quota, initial payment, retry, refill, refund, expiry and no-credential failure.

## Remaining work before deployment

1. Build the foreign-VPS DoT SNI / DoH URL gateway and validate normal DNS responses, SNI-derived subscriber identity, wildcard TLS, no unknown-host fallback and DoH GET/POST. Do not replace live CoreDNS or Nginx blindly.
2. Route that gateway to the existing CoreDNS SmartDNS policies and direct fallback. Keep all normal domains resolving when the quota is exhausted.
3. Measure p50/p95 from phones and under concurrent queries. A cross-VPS PostgreSQL write on every query is a reference implementation, not a performance guarantee. If slow, meter locally on the same foreign VPS with bounded batching and crash-safe reconciliation.
4. Preserve existing VPN/Telegram listeners on 443 and the public DoT on 853, with canary and rollback. Verify Android Private DNS, iOS/macOS profile and mobile/Wi-Fi.
5. Personal DNS links do NOT enforce the shared 443 proxy TCP access; direct IPv4 bypass remains. Product must advertise the service as a fair-use DNS query allowance, not a guaranteed maximum number of HTTPS connections.
6. Current billing plans still contain the legacy dns_quota_bytes attribute. Keep the new lookup quota visible separately and migrate customer-facing copy/pricing before any commercial switch.

Standards: https://www.rfc-editor.org/rfc/rfc7858 (DoT), https://www.rfc-editor.org/rfc/rfc8484 (DoH), https://developers.google.com/speed/public-dns/docs/using (Android Private DNS).
