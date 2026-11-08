# Gemini without VPN — exact-domain Smart DNS canary

**Status (2026-11-08): not live yet.** Initial public 443 and DNS canaries were reverted on automatic checks. The latest remote canary passed strict Google TLS and all four Gemini DNS record types locally, but the external probe incorrectly required an unchanging TTL of exactly 20 seconds. Its test is corrected and needs a new full E2E run.

## Verified architecture
- Android Private DNS is DNS-over-TLS on dns.mnebyvpn.site:853.
- For gemini.google.com only, CoreDNS synthesizes A=89.125.90.101, TTL <=20s, and returns NOERROR/NODATA for AAAA, HTTPS(65) and SVCB(64); other names continue to authenticated Quad9 DoT.
- Existing foreign Nginx public 443 has a shared 26-rule SNI map. Adding one exact Gemini entry routes encrypted TCP to its private loopback 127.0.0.1:15443 intermediary. The intermediary preserves the original Google TLS certificate and denies unknown SNI.
- The intermediary is running in its own limited-memory/CPU systemd service and is independent of the existing Xray VPN, Telegram proxies and DoT service.

## Verified and pending tests
- PASS: actual CoreDNS query A/AAAA/HTTPS/SVCB, with non-target Google addresses remaining unmodified. [DNS test](https://github.com/grunvald91/Mnebyvpn/actions/runs/42460703930).
- PASS: real foreign Google TLS passthrough over loopback for tested hostnames, plus unknown SNI denial. [Foreign test](https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42458771724).
- PASS: real production SNI table reproduced on separate localhost 15445; Gemini had valid TLS and HTTP 200. [Isolated map test](https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42461702061).
- PENDING: external full public 853+443 E2E checks all pass together; preserve shared 443 VPN and support services and disarm recovery watchdog.
- PENDING: phone browser in Russia, VPN off; login and all supporting Google domains, DNS/no-leak and IPv6/HTTP3 behavior.

## Limitations
Google AI requires additional hostnames, authorization and region/account eligibility. An HTTPS 200 on the landing page is not proof that the logged-in Gemini app will work. This pilot deliberately does not redirect every Google domain. DNSSEC validating clients, browser-native DoH, cached alternate services, ECH and QUIC may change the observed behavior. Android INCY DNS compatibility is separately tracked; this pilot does not change its VPN connection.

References: [CoreDNS template](https://coredns.io/plugins/template/), [CoreDNS cache TTL behavior](https://coredns.io/plugins/cache/), [Nginx stream ssl_preread](https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html).