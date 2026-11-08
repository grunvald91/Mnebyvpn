# MNEBYDNS — Android Private DNS public DoT pilot

**Status 2026-11-08: public DNS-over-TLS pilot LIVE at `dns.mnebyvpn.site:853/TCP`.** Initial issuance of trusted certificate and external CA-valid DoT tests PASS. The owner explicitly approved removing the source-IP allowlist for this temporary pilot. Service is not a completed Smart DNS foreign HTTPS egress product; it is not ready to sell.

**Live verification:** https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42457054783 . Post-deploy audit: https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42455201845 (later rerun).

## User-facing behavior

In Android 9+ Settings → Network & Internet → Private DNS, enter only the hostname `dns.mnebyvpn.site`, never a URL, IP address, or port. The DoT endpoint is currently accessible over public IPv4/TCP853, without an IP allowlist. Test Android on Wi-Fi with VPN off first. A separate VPN client can change DNS behavior; check actual routing before promising simultaneous use. A separate VPN client can change DNS behavior: run device-specific tests.

Source: https://developers.google.com/speed/public-dns/docs/using ; https://developers.google.com/speed/public-dns/docs/dns-over-tls/

## Mandatory gates (in order)

1. **DONE:** A record for `dns.mnebyvpn.site` now points to foreign egress. It was verified using two independent public recursive resolvers plus the delegated authoritative NS. The site root/NS and web/mail remain untouched. **No AAAA** until global IPv6 exists.
2. **DONE (initial issuance):** Let's Encrypt certificate was issued for `dns.mnebyvpn.site` via a dedicated exact-hostname HTTP-01 Nginx webroot, without taking ports 80/443 away from existing services. Certificate chain and hostname verified. Existing Nginx configuration remains valid. Expiry: **2027-02-06**. Certbot reported a scheduled renewal mechanism; its real renewal and DNS-service reload must still pass tests before unattended availability is claimed.
3. **PILOT EXCEPTION APPROVED BY OWNER:** allow all source IPs for temporary evaluation. This is an unauthenticated public DNS resolver; a hostname is not a subscription credential. This phase must NOT be treated as paid Smart DNS authorization.
4. Earlier private-pilot configuration remains available for future per-IP experiments. Generate a candidate config using `python3 ops/smart-dns-poc/render-android-pilot.py --bind-ip <verified-foreign-ip> --allow-client-ip <verified-client-ip> --output <new-temp-file>`. The renderer rejects wildcards, CIDR ranges, private IPs, duplicate client/bind address and existing output file. No service is started by the renderer.
5. **DONE:** Public TCP853-only listener is active as independent CoreDNS systemd service (DynamicUser, MemoryMax=160M, MemoryHigh=112M, CPUQuota=20%, TasksMax=48, LimitNOFILE=256; forward max_concurrent=16). No firewall, VPN or Nginx 443 modifications. These are **resource ceilings, not per-client QPS rate limiting or complete DDoS protection**. Maintain monitoring and a scoped rollback, add anti-abuse controls before general/commercial release.
6. **DONE:** External runner verified strict TLS identity, successful A/AAAA/NXDOMAIN and rejection of wrong hostname. UDP/53 is not exposed by this DoT service. **PENDING:** CNAME/HTTPS/SVCB coverage, mobile Android off/on/off + VPN compatibility, longitudinal stability and alerting.
7. **DONE (staging test):** Certbot successfully simulated renewal for the exact DNS certificate, and an isolated exact-lineage deploy hook was installed and tested: it restarted only `mnebydns-dot.service`. Real DoT queries and TLS validation still passed afterward. [Renewal test log](https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42457346199). A future real unattended renewal remains to be observed; this is not authenticated-per-account Smart DNS.
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

**GO for temporary public DNS-only pilot** with owner's explicit authorization and resource caps. **NO-GO** for paid subscriptions, general product release or claimed Google Smart DNS until robust anti-abuse controls, renewal, client E2E, and independent HTTPS relay authorization are proven. No source-IP binding applies to the pilot.
