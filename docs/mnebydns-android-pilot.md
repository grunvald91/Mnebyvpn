# MNEBYDNS — Android Private DNS single-device public pilot

**Status (2026-11-08): public DNS A record verified and Let's Encrypt TLS certificate issued (expiry 2027-02-06). NOT LIVE:** TCP/853 is not listening, test client source IPv4 has not been supplied or allowlisted, on-device E2E and renewal have not been tested. This is a staging procedure, not a paid or generally available Smart DNS product.

## User-facing behavior

In Android 9+ Settings → Network & Internet → Private DNS, enter only the hostname `dns.mnebyvpn.site`, never a URL, IP address, or port. Do not tell people to activate it until a **publicly reachable, TLS-verified and access-controlled TCP/853** resolver is confirmed, otherwise DNS resolution may fail. A separate VPN client can change DNS behavior: run device-specific tests.

Source: https://developers.google.com/speed/public-dns/docs/using ; https://developers.google.com/speed/public-dns/docs/dns-over-tls/

## Mandatory gates (in order)

1. **DONE:** A record for `dns.mnebyvpn.site` now points to foreign egress. It was verified using two independent public recursive resolvers plus the delegated authoritative NS. The site root/NS and web/mail remain untouched. **No AAAA** until global IPv6 exists.
2. **DONE (initial issuance):** Let's Encrypt certificate was issued for `dns.mnebyvpn.site` via a dedicated exact-hostname HTTP-01 Nginx webroot, without taking ports 80/443 away from existing services. Certificate chain and hostname verified. Existing Nginx configuration remains valid. Expiry: **2027-02-06**. Certbot reported a scheduled renewal mechanism; its real renewal and DNS-service reload must still pass tests before unattended availability is claimed.
3. Choose one **explicit, measured public client source IPv4** for the controlled pilot. Android DoT carries no standard arbitrary subscription token. A DNS hostname itself is not a secure user credential, and this phase must never expose a general open recursive resolver. Note that cellular/Wi-Fi changes can change the public IPv4: a client may need re-enrollment.
4. Generate a candidate config using `python3 ops/smart-dns-poc/render-android-pilot.py --bind-ip <verified-foreign-ip> --allow-client-ip <verified-client-ip> --output <new-temp-file>`. The renderer rejects wildcards, CIDR ranges, private IPs, duplicate client/bind address and existing output file. No service is started by the renderer.
5. Review the exact config, cert permissions, systemd service isolation, memory/CPU limits, network listeners and rollback. First bind only loopback for E2E verification; then opt-in to public **TCP/853 only**, with network-level ingress controls and the CoreDNS ACL, without modifying the existing VPN, 443 reverse-proxy or other services.
6. From a separate external network, validate strict DoT TLS identity, A/AAAA/CNAME/HTTPS/SVCB DNS answers, valid allowlisted source, refusal for unauthorized source, absence of UDP/53 open recursion, resource stability, and Android off/on/off plus VPN compatibility. After the pilot confirm a baseline of existing services and alerting.
7. Document how public cert auto-renewal is guaranteed. Until safe renewal and abuse controls are operational this remains a private pilot. It must not be sold as authenticated-per-account Smart DNS.
8. **Only after all above** develop controlled domain-based HTTPS relay (Google Gemini / AI Studio candidates) with independent SNI ingress authentication, quotas and revocation. DNS-only gives no foreign website-observed egress IP.

## What is already tested

- Native CoreDNS 1.15.0 DoT queries on foreign VPS with ephemeral local-only certificate; no public listener or permanent installation.
- In a disposable runner, CoreDNS ACL allows one loopback source and returns REFUSED for another. See `probe-acl.py` and `run-acl-pilot-test.sh`.
- `render-android-pilot.py` renders a strict /32 allowlist but is **not** wired into real network traffic.
- Foreign host had no globally scoped IPv6 at preflight; no per-subscription IPv6 identity assumptions.

Official references:
- CoreDNS ACL: https://coredns.io/plugins/acl/
- CoreDNS TLS: https://coredns.io/plugins/tls/
- Certbot challenge requirements: https://certbot.eff.org/instructions
- Let's Encrypt DNS-01: https://letsencrypt.org/ru/docs/challenge-types/
- Jino DNS editing: https://o.jino.ru/help/faq/domains-general/dns-record/

## Release decision

**NO-GO** for public anonymous DoT, paid subscriptions and claimed Google Smart DNS until true E2E, certificate renewal and independent ingress authorization are proven. Initial DNS and certificate prerequisites have passed; now require a specific approved test-client IPv4 and safely staged TCP/853 service before Android can be switched on.
