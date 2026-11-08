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

## Verified 8 November 2026: CI/network acceptance

- [15/15 exact hosts, original TLS 1.3 preserved through localhost-only SNI proxy](https://github.com/grunvald91/Mnebyvpn/actions/runs/42474781726): six Google, four YouTube, five Instagram/Meta. Run from an external GitHub runner, NOT the foreign VPS or a Russian client. Unknown SNI rejected.
- [Live read-only public DoT / preserved Gemini and Discord](https://github.com/grunvald91/Mnebyvpn/actions/runs/42475591213): all 15 candidates stayed unpromoted at that moment. This does not prove Instagram or YouTube app access.
- Earlier DNS checks occasionally received SERVFAIL for api.instagram.com, ssl.gstatic.com and domestic control gosuslugi.ru. This did not recur consistently. The evidence does not locate a single responsible layer. [First DNS failure](https://github.com/grunvald91/Mnebyvpn/actions/runs/42474952727); [subsequent regression check](https://github.com/grunvald91/Mnebyvpn/actions/runs/42475297345).
- Prepared STAGING ONLY: render-resolver-fallback-lab.py preserves exact DNS rules and adds the second official Quad9 DoT endpoint (149.112.112.112) after 9.9.9.9 with the same validated TLS hostname. Sequential policy and SERVFAIL-only response failover do not bypass NXDOMAIN policy blocks. Network failure also causes a next-upstream attempt. [Quad9 server list](https://docs.quad9.net/services/), [CoreDNS forward specification](https://coredns.io/plugins/forward/).
- [Deterministic real CoreDNS 1.15.0 encrypted failover PASS](https://github.com/grunvald91/Mnebyvpn/actions/runs/42476163206): primary TLS mock returned SERVFAIL, secondary returned an A record, the main resolver returned the second; healthy primary stayed primary and Gemini synthetic A remained intact. All tests bound localhost using a temporary test certificate. This proves staging logic, NOT production reliability.

## Requirements before live fallback cutover

1. Audit active Corefile, CoreDNS version, Gemini and Discord rules, free memory, CPU, and listener map.
2. Back up the exact active Corefile; refuse symlinks, drifted sources and mismatched changes. No Nginx, Xray or public HTTPS edits. Validate the staged syntax, arm a short automatic rollback watchdog and restart only the DoT resolver.
3. Repeat real strict-CA DoT queries for A, AAAA, HTTPS and SVCB for Gemini, Discord and important unpromoted sites, plus Russian-only services, multiple rounds to catch intermittent SERVFAIL. Verify latency, service resource limits and lack of plaintext DNS listeners.
4. Promote to production only after external E2E, a verified automatic rollback, and separate authorization for infrastructure mutation. This stage does NOT deploy itself and cannot fix client-network SNI filtering for Meta.

An earlier local TLS fixture did not supply its self-signed CA to the internal CoreDNS upstream client. That was a fixture trust problem, not proof of a CoreDNS bug; the final test supplied the temporary local CA and passed.

## YouTube: Russian-network throttling vs provider geoblocking (clarification)

**Do not claim that YouTube generally geo-denies Russian viewers.** Our engineering priority is Russian-network slowing, selective interference and inconsistent DNS/TLS access; it is distinct from YouTube platform regional restrictions on particular content, ads and paid features.

Independent references:
- OONI: https://ooni.org/post/2024-russia-report
- HRW: https://www.hrw.org/report/2025/07/30/disrupted-throttled-and-blocked/state-censorship-control-and-increasing-isolation
- Carnegie: https://carnegieendowment.org/russia-eurasia/politika/2025/02/russia-youtube-block-attempt
- Official YouTube video bandwidth: https://support.google.com/youtube/answer/78358
- Official separate YouTube ads/monetization restriction: https://support.google.com/youtube/answer/1342206

Russian-vs-foreign VPS baseline: 0/4 selected YouTube names succeeded directly from the sampled Russian VPS, while 4/4 succeeded from the foreign VPS. Two failed resolution and two timed out. This is one network observation, not proof of identical blocking at every Russian ISP. In Russian-to-foreign ingress screening TCP/443 succeeded but certificates did not match YouTube because their exact SNI routes were NOT enabled. Source: https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42477498823.

**Acceptance is actual video playback, not merely a loading web page.**

1. Test page/auth/static, API, and actual media segments/CDN separately. The two-host staged canary for www.youtube.com and youtubei.googleapis.com does not cover playback.
2. Investigate exact, dynamic per-session media CDN hostnames from consented client diagnostics. Store only hostnames, never full video URLs, videoplayback query parameters, signatures, tokens, cookies, identifiers, or browsing history. Never bulk rewrite the entire googlevideo.com wildcard to a single fixed IP.
3. On a Russian-network Android phone compare direct access, Private DNS with VPN off, and VPN fallback. Measure initial load time, 5-10 minute buffering events, sustained video bitrate, 720p and 1080p playback, and stability on both mobile and home internet.
4. YouTube documentation recommends sustained speeds of about 2.5 Mbps for HD 720p and 5 Mbps for 1080p. These figures are service requirements, NOT measured MNEBYDNS speeds.
5. Test QUIC/HTTP3 UDP 443, IPv6, HTTPS/SVCB, browser DoH, and compatibility with Android system Private DNS. An Nginx TCP TLS/SNI passthrough does not automatically proxy or accelerate QUIC.
6. Separate the Russian access-network issue from video-by-video regional licensing, advertising and monetization restrictions.

Do not promote any route or advertise YouTube playback as solved until a measured end-to-end sample on an actual Russian-client network passes and existing Gemini/Discord/VPN routes remain healthy.
