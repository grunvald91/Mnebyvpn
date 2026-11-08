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

## November 8: real two-host YouTube integration in isolated CI

The first runnable two-host YouTube canary now has a [dedicated **passing** CoreDNS + Nginx integration run](https://github.com/grunvald91/Mnebyvpn/actions/runs/42478814801). Unlike the previous string-only policy tests, this launches actual CoreDNS 1.15.0 on a localhost DoT test listener and a separate Nginx stream sidecar on localhost, then verifies:

- Exact YouTube A rewrite for www.youtube.com and youtubei.googleapis.com; compatible empty AAAA/CNAME/SVCB/HTTPS responses (including strict CA/hostname checks for the test DNS certificate).
- Real TLSv1.3 origin certificates for BOTH YouTube domains via the local-only SNI proxy, without HTTP traffic inspection.
- Existing four Gemini/Discord exact synthetic A policies survive in the same combined Corefile.
- Unknown SNI fails closed. No public DNS, production nginx:443, VPN, Xray, certificate or subscriber is changed.
- Six staging unit/security tests also passed.

**NOT established:** Russian client-to-ingress reachability after an actual route promotion, DNS behavior on the user's Android device, QUIC/UDP, streamed video/CDN hosts or playback quality.

The next release action is a separate *operator-controlled limited pilot* after an audited production configuration backup and rollback watchdog. Only www.youtube.com and youtubei.googleapis.com would be admitted initially, with TLS handshake validation from Russian ingress, existing Gemini/Discord health and recovery on any failing condition. In the first pilot, do NOT promise streaming or accelerate video CDNs; collect consented user playback measurements without individual video URLs or cookies.

A single-time CI pass is not a production release gate. Recheck the branch and CI at current head before considering any rollout.

## Broad Google ecosystem policy: user decision, Nov 8

**User preference updated:** route the entire known Google / Gemini / YouTube domain ecosystem through the foreign SNI proxy rather than cherry-picking a few endpoints. A small exact-host-only trial is insufficient for dynamic Googlevideo media names, Youtube thumbnails and Android Gemini dependencies. This is a **Google suffix policy**, not an arbitrary proxy for unrelated hostnames.

### Implemented (STAGING ONLY)

The generator ops/smart-dns-poc/stage-google-ecosystem-suffix.py adds 22 bounded domain suffix families including google.com, googleapis.com, gstatic.com, googleusercontent.com, googlevideo.com, youtube.com, ytimg.com, ggpht.com, youtu.be and other related domains. Each suffix includes all its subdomains. Other traffic remains with the existing DNS service. Existing exact Gemini and Discord rules remain intact. Do not substitute this draft for production CoreDNS or Nginx configs.

- Synthetic DNS-over-TLS A answers target the foreign HTTPS ingress; AAAA, CNAME and HTTPS/SVCB for those same Google names receive empty responses to prevent IPv6/HTTPS routing bypass.
- Existing public Nginx stream SNI map gains one suffix-regex rule pointing only to a new loopback port. Existing exact SNI entries have priority and are retained byte-for-byte.
- The isolated sidecar forwards original encrypted TCP/TLS streams by SNI to the **real** Google hostname. No SSL interception, CA substitution or HTTP inspection. Any non-Google SNI is denied.
- A separate localhost-only origin DNS resolver uses authenticated Quad9 DoT, not the public synthetic Google A mapping. This prevents recursive routing to the proxy itself and avoids unencrypted DNS for origin resolution.
- A global catchall or dynamic arbitrary-host proxy was **not** created. Unverified third-party CDN infrastructure and Google Cloud customer-operated app hostnames are outside the static suffix list until ownership and routing are grounded.

**Passing integration**: https://github.com/grunvald91/Mnebyvpn/actions/runs/42483424292 . This ran real pinned CoreDNS 1.15.0 and Nginx, 6 security unit tests, 17 expected Google synthetic A plus AAAA/CNAME/HTTPS/SVCB policies, 7 genuine origin TLS certificates, preserved original Discord DNS and rejected three unrelated SNI names. Both DNS and proxy bound only to localhost and all ephemeral listeners were cleaned up. The staging does not change live production.

Sources and implementation constraints: 
- Google official Gemini connectivity list: https://knowledge.workspace.google.com/admin/generative-ai/gemini-app/gemini-app-firewall-settings
- CoreDNS template and fallthrough behavior: https://coredns.io/plugins/template/
- Nginx stream map priority and regex: https://nginx.org/en/docs/stream/ngx_stream_map_module.html
- Nginx encrypted original-TLS SNI inspection: https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html

### Release blockers and honest limits

1. No successful fresh **production** dry-run of broad suffix rules against the current foreign live config has been recorded. Do not treat the localhost CI as validation of production compatibility or as an authorization to restart the shared public Nginx/DoT/other VPS services.
2. The previous Gemini RPC pair is not known to fix Android Gemini voice, and was actively rolled back after the user observed an earlier Android error. Broad rerouting is a new hypothesis and can trigger regional/identity challenges. Validate Google login, Gemini text, Gemini browser voice and Android app voice independently.
3. DNS does NOT conceal the user's region on its own; the user-facing origin IP becomes foreign **only** when the matching SNI connection successfully uses the foreign egress. Google may additionally infer country from the signed-in account, SIM, device signals, GPS, cookies, or request data. Never promise that all Google apps will see a foreign location.
4. This proxy handles TCP/443, **not QUIC/HTTP3 UDP/443**. Dynamic googlevideo media host DNS was proven syntactically, not live playback. Media speed tests from a real Russian carrier/Android are still required. Only a supported client VPN transport can guarantee routing of unsupported traffic.
5. A wildcard Google route increases server traffic and abuse surface. Before global enablement: resource budget, access controls, per-client quotas or equivalent protections, backups and snapshot-aware watchdog rollback, preflight of live shared Nginx map, DNS and foreign-origin resolution, Russian-side strict TLS, and Android end-to-end verification.

**Status at 2026-11-08:** staged code and tests PASS; production unchanged, Gemini Android voice and YouTube image/video playback unverified. Do not advertise these features as already fixed.

## 2026-11-08 code review: Google-wide and exact YouTube canaries

### Fixed and verified in branch

- **P1: live Nginx shadowing.** A newly inserted broad regex used to be evaluated before pre-existing regex entries. Changed to append at the end of the SNI map. Nginx exact entries and prefix masks take priority over regex; unknown exact Google entries and overlapping wildcard/prefix masks now cause staging to fail closed instead of silently changing a shared route. Source: https://nginx.org/en/docs/stream/ngx_stream_map_module.html
- **P2: case-sensitive SNI/DNS policy.** The broad proxy now uses `~*` for Nginx stream map matches and `(?i)` for CoreDNS Go regexp matches. Real TLS and DoT tests include mixed-case YouTube/Googlevideo/Google API names. DNS case-insensitivity is standardized in RFC 4343: https://www.rfc-editor.org/rfc/rfc4343
- **P2: wrong YouTube DNS assertion.** The unused earlier additional RR probe erroneously expected Google DNS to synthesize `9.9.9.9` (Quad9 resolver) instead of the actual foreign HTTPS ingress. Fixed to use the existing pilot's shared ingress value and wired it into YouTube integration CI.
- **P2: plaintext foreign origin DNS.** The exact two-host YouTube SNI prototype used Nginx `resolver 9.9.9.9`, which sends unencrypted DNS requests. Replaced it with a local origin CoreDNS on port 5355 forwarding strictly over Quad9 DoT, and exercised it in the actual CoreDNS/Nginx CI. Removed an obsolete untested second dual-host prototype also using plaintext DNS.
- **P2: incomplete Nginx syntax verification.** Broad Google CI now checks the generated shared SNI map, not just the sidecar, using unprivileged temporary PID and listener paths. Existing service/Discord DNS and unknown-SNI fail-closed regression checks are retained.

### Verification

- [Full Google wildcard policy CI PASS](https://github.com/grunvald91/Mnebyvpn/actions/runs/42484984681): real CoreDNS and Nginx, 11 security tests, mixed-case DNS and TLS, valid origin certificates, existing Discord routes and strict unknown SNI denial.
- [Exact YouTube pilot + encrypted origin DNS CI PASS](https://github.com/grunvald91/Mnebyvpn/actions/runs/42485253569): real CoreDNS DoT, Nginx TLS, independently corrected extra DNS record probe, preserved Gemini and Discord.
- [15-host priority research lab CI PASS](https://github.com/grunvald91/Mnebyvpn/actions/runs/42485223348), which is still nonproduction; that standalone GitHub-runner research fixture is not a production encrypted-origin DNS service.

### Unresolved release blockers: must not promote to production

1. **P1 / architectural:** a public wildcard synthetic A answer for all `*.google.com` and `*.googleapis.com` sends even non-HTTPS (and UDP) connections to the foreign TCP443 ingress, which cannot serve those protocols. In particular, official Google FCM documentation identifies `mtalk.google.com` and TCP ports 5228–5230; Google says this push protocol cannot be handled by network proxies. Google also documents `time.google.com` UDP123. A broad DNS-only override can break Android push and time sync. Do not release full wildcard SmartDNS until unsupported ports/hosts bypass the rewrite or a compatible client VPN transport owns those routes. Sources: https://firebase.google.com/docs/cloud-messaging/network-configuration and https://support.google.com/work/android/answer/10513641
2. **P1 / production:** live shared 443 config and public DoT have not been verified against the most recent staging generator. Existing exact Google entries and wildcard SNI masks must be audited first; the stager now refuses unreviewed overlaps. Backup, atomic rollout and rollback watchdog are mandatory. It must not modify Xray, unrelated VPN services or other users' configurations.
3. **P1 / privacy and capacity:** public TCP443 sidecar does not authenticate or meter subscribers; looping through the shared public 443 dispatcher also loses the client source IP at the sidecar. No quota, abuse controls, throughput capacity, or accounting has been validated for broad Googlevideo streaming.
4. **P1 / client compatibility:** DNS-only policy cannot force apps using QUIC/HTTP3 UDP443, own DoH resolvers, IPv6-only/NAT64 or other ports through the TCP SNI proxy. Real Android Google Gemini text/voice and YouTube thumbnail/stream playback remain unverified.
5. **P2 / exact scope:** 22 vetted suffix families cover the 34 currently documented Gemini firewall hostnames but are **not** a verified exhaustive inventory of every Google-owned, Google Cloud-hosted or third-party CDN domain. No blanket claim of total Google coverage.

**Release decision:** keep PR #74 Draft and staging-only. Fixing the production P1s requires design beyond pure DNS rewriting (client-controlled routing or explicit bypass). A green localhost TLS/DNS test does not establish successful Android app access, bypassing all regional checks, or YouTube video performance.
