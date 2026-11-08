# MNEBYDNS: Google / YouTube / Instagram — next safe stage (2026-11-08)

## Status

**Implemented on this branch:** a fixed 15-exact-host, loopback-only TLS/SNI laboratory. Its Python compiler generates an independent Nginx stream proxy on localhost TCP/15447 with default deny. Each TLS connection uses the original upstream domain and preserves its end-to-end certificate; HTTPS bodies, credentials and cookies are not decrypted. Unknown SNI is sent to a closed loopback port.

**NO production changes:** this branch does not change active public DoT, TCP/443, VPN, billing, or existing Gemini and Discord services.

**Separately LIVE:** the exact Gemini and three Discord routes, as reported in [Gemini #70](https://github.com/grunvald91/Mnebyvpn/pull/70) and [Discord #73](https://github.com/grunvald91/Mnebyvpn/pull/73).

**Blocked from public release:** Instagram www.instagram.com failed the real Russian-to-foreign-IP TLS handshake in the previous six-host pilot, despite a successful foreign loopback certificate test. Do not blindly retry that DNS rewrite unchanged. YouTube and Google support hosts have not yet passed an equivalent public Russian-ingress and on-device acceptance matrix.

## Why these 15 candidate hostnames?

The file ops/smart-dns-poc/priority-service-hosts.json is NOT a full dependency list:
- Google (six exact hosts): web search, accounts, AI Studio, gstatic content, OAuth API. Sources: [Chrome allowlist](https://support.google.com/chrome/a/answer/6334001), [Google Workspace OAuth endpoints](https://support.google.com/a/users/answer/2622308), [foreign relay tested hosts #67](https://github.com/grunvald91/Mnebyvpn/pull/67).
- YouTube (four exact hosts): web, internal API candidate, thumbnails, login. Sources: [official embed requirements](https://support.google.com/youtube/answer/171780), [Google accounts.youtube.com allowlist](https://support.google.com/chrome/a/answer/6334001), [measured two-host baseline #73](https://github.com/grunvald91/Mnebyvpn/pull/73).
- Instagram (five exact hosts): web, API, gateway, static assets and related Facebook web candidate. Sources: [Instagram application domain inventory](https://www.netify.ai/resources/applications/instagram), [www.instagram.com](https://www.netify.ai/resources/hostnames/www.instagram.com), [api.instagram.com](https://www.netify.ai/resources/hostnames/api.instagram.com).

These references provide candidate host associations, not proof of operating a fully authenticated service over this relay.

## Release gates

1. Lab only, on an authorized foreign host: run Python tests, generate the Nginx config inside a unique temporary directory and check nginx -t. Temporarily launch it only at 127.0.0.1:15447 with a bounded timeout and strict cleanup. For each exact host check original CA/TLS with curl --connect-to host:443:127.0.0.1:15447. An HTTP 302, 403 or 404 is not by itself a failure of the TLS test. Ensure a random SNI is rejected.
2. Test from a Russian network whether TLS carrying that original visible SNI can reach the foreign public ingress. A successful foreign-only loopback test is insufficient. If the name is filtered on the route, do not proceed with DNS rewrites.
3. Only for names that pass, propose a separate transactional incremental SNI/DNS change that preserves existing VPN, Gemini, Discord and Telegram routes, with backup, rollback watchdog, sidecar resource limits and strict public TLS/DoT verification.
4. On actual Android with VPN off, strict Private DNS and the intended apps, verify Google auth and voice, YouTube video playback and media CDN hosts, Instagram images/Reels, IPv6, HTTPS/SVCB, QUIC/HTTP3, browser DoH and regional/account requirements.

**DNS-only limitation:** Private DNS is NOT a VPN tunnel. Where the network filters the application's original visible SNI, the DNS redirect may fail even with a perfectly functional foreign TLS relay. Such sites require an independently validated route or supported client encrypted transport.

No subscriber authentication, per-account quotas, wildcard routes or public commercial Smart DNS readiness are added here. All 15 entries are explicitly unverified.
