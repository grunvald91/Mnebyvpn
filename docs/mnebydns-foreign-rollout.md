# MNEBYDNS — foreign-only pilot sequence

**Status: code and offline tests; no foreign VPS deployment.**
The MNEBYDNS test is independent of any subscription to, or internals of, Aeternia. An Aeternia account can be useful only for later opt-in black-box comparisons on an owned test device.

## Separation of concerns

- Existing Russia-based service: optional account, billing, and management **control plane**. Never put this service in the middle of the user DNS/HTTPS data path.
- Existing foreign VPS: intended **DNS-over-TLS resolver and subsequent allowlisted HTTPS relay**. No new VPS purchase is needed for the isolated trial.
- Ordinary domains: resolver returns normal DNS answers; browser/app connects to service directly, **not through foreign VPS**.
- Independently verified allowlisted domains: future HTTPS TCP ingress may route traffic through foreign egress, *if* the client supports the path and TLS to origin verifies. DNS-only cannot do this.
- Android Private DNS + a separate VPN client may interact; never promise compatibility before on-device off/on/off testing.

## Phase A — encrypted DNS pilot on the foreign VPS

1. Repeat private read-only CPU, memory, disk, port and network capacity audit; note foreign VPS has limited free disk and that an existing service uses public 443.
2. After approving the host and test window, stage only `ops/smart-dns-poc` in a **separate directory** with no new firewall, Nginx, Xray or public port changes. The current compose publishes only 127.0.0.1:1853.
3. Generate an ephemeral self-signed key **only on that test host**, never in GitHub. Verify strict local TLS identity via `kdig` and upstream DNS-over-TLS with tests of A, AAAA, CNAME, HTTPS, SVCB, NXDOMAIN and timeouts. Check latency, restarts, RAM/disk/CPU, compare to preflight.
4. Roll back simply by stopping/removing the isolated test compose project. Existing VPN traffic must remain unaffected. This is not yet usable through Android Private DNS.
5. For public Android trial, separately obtain a dedicated hostname and trusted certificate, configure secure, abuse-resistant TCP/853 reachability and verify from at least two networks. **Never expose an unauthenticated open resolver merely to test the phone UI.**

## Phase B — per-service routing

- Start from an **empty enabled allowlist**. Build a service-domain inventory from controlled client observations, not by guessing or wildcarding all google.com or googleapis.com.
- `packages/dns-policy/src/domain-routing.ts` classifies exact domain rules; it is an **offline admission model**, not a CoreDNS plugin or proxy. A **verified** proxy-only domain becomes `blocked` when route revision/ingress/security checks fail; it must not silently fall back to a direct foreign-IP disclosure. Unlisted/testing/disabled domains remain direct.
- Every route must pass independent DNS-RR and client HTTPS tests for IPv4, IPv6, CNAME, HTTPS/SVCB, QUIC/ECH, certificate verification, source egress, and compatibility with VPN mode. Unverified domains stay direct. **Crucially: the `blocked` result is only a policy result today. DNS alone cannot prevent a client reusing cached addresses, contacting origin by IP or using application-native DNS; enforceable no-fallback needs a cooperating client/system route policy and on-device leak tests.**
- Ingress must independently authenticate paid entitlements and enforce quota and revoke; DNS tokens cannot themselves authenticate TCP connections. No public/paid SNI access until this is demonstrated.
- Initial *candidate services* for a later experiment: Google Gemini and Google AI Studio, but no claim their complete domain inventory is known or their traffic is already routed.

## When Aeternia helps

Only after we have our own baseline and can observe the exact difference: optional user-supplied free trial/subscription for comparison of network behavior with identical device, network, and target. Public materials and the user's practical observations are enough to **begin building our own components today**. No dependence on Aeternia's source code, endpoints, certificates, keys or brand.

References: [Smart DNS design](smart-dns.md), [RR compatibility](dns-record-policy.md), [commercial/auth gate](smart-dns-access-gate.md), and [DNS/VPN policy](decisions/0006-private-dns-vpn-privacy-performance-egress.md).
