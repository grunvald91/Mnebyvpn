# MNEBYDNS selective access beyond Google — source-led project

**8 November 2026.** This is a staged, exact-host pilot, not a promise to make every blocked website or app work. The publicly deployed service currently keeps `gemini.google.com`; a Discord-only canary is under controlled deployment. Do not confuse research candidates with working routes.

## Evidence sources and their limitations

- [OONI Explorer findings](https://explorer.ooni.org/findings) give independent evidence of Russian ISP interference. [Discord finding](https://explorer.ooni.org/findings/2025-russia-blocked-discord) is particularly relevant. Blocking varies by ISP/region.
- [itdoginfo/allow-domains](https://github.com/itdoginfo/allow-domains) separates blocked, geoblocked and Russian-only domains, but it is a community-maintained routing list, not evidence that all entries are currently blocked.
- [runetfreedom/russia-blocked-geosite](https://github.com/runetfreedom/russia-blocked-geosite) provides ru-blocked, ru-blocked-all, ru-available-only-inside and service categories, with potentially **hundreds of thousands** of candidate domains. This cannot be imported wholesale as DNS-to-one-IP rules, since each origin still needs an exact SNI route, the original cert, appropriate protocols and ingress capacity.
- [OpenAI supported regions](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries) and [unsupported-region policy](https://help.openai.com/en/articles/9131992-chatgpt-and-api-services-in-unsupported-countries-and-territories) explain provider-imposed access policy; an externally reachable TLS socket does **not** establish that accessing or offering the service is authorized in a location. An account can be blocked.

## Independent RU-vs-foreign TLS sample

[Full runner and foreign/RU VPS measurements](https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42466365042) tested 25 exact hostnames, strict public TLS, no user requests or passwords.

| Service | RU VPS observation | Foreign VPS observation | Decision |
|---|---|---|---|
| Discord: `discord.com`, `gateway.discord.gg`, `cdn.discordapp.com` | all three timed out (~6 s) | TLS validated for all three | First public exact-host pilot candidate; Android app/voice still unverified |
| Instagram/Facebook: three exact hosts | RU resolver returned an address-resolution error | TLS validated | Initial six-host pilot failed: from RU VPS to **foreign IP** `www.instagram.com` had TLS handshake timeout. Cannot solve all Meta accesses with simple DNS/SNI redirect |
| YouTube `www.youtube.com`, `youtubei.googleapis.com` | first failed DNS, second timed out | both TLS validated | Future protocol/CDN research, not live |
| X `x.com`, `abs.twimg.com` | main website TLS worked, CDN timed out | both TLS validated | Partial service issue, not safely all-X |
| Bluesky `bsky.app`, `api.bsky.app` | first DNS failure, second TLS worked | both TLS validated | Future pilot candidate |
| ChatGPT/OpenAI 4 hosts; Claude 2 hosts | TLS worked to all tested names | TLS worked | TLS is **not** evidence of supported region/account access. Research only |
| Perplexity, TikTok, Spotify, archive.org, Roblox | TLS worked in this sample | TLS worked | No grounds for blanket DNS rewrite |

**No claims about other Russian ISPs can be drawn from a single RU VPS.** Nor can TLS handshake success prove functioning logged-in websites, voice, video, QUIC, OAuth or WebSocket. HTTPS/SVCB (including ECH hints), IPv6, DNSSEC-validation and browser DoH must be tested on actual clients.

## Route admission

- Research catalogue: `packages/dns-policy/src/ru-access-candidates.ts`. Every entry remains `research-only`, regardless of candidate stage. No route automatically goes live from this list.
- Explicit first pilot: `ops/smart-dns-poc/ru-access-first-pilot.json`; **Discord only** after Meta failed a Russian foreign-ingress canary.
- Compiler: `stage-ru-access-pilot.py` creates `nginx.pilot`, `dns.pilot`, `relay.conf` without touching running services. It validates exactly the approved hosts, refuses wildcard/suffix matching and duplicate routes, and preserves the shared original Gemini, Xray and Telegram SNI map.
- Public DoT sends an exact A to foreign IPv4; synthetic AAAA/HTTPS/SVCB are NODATA to prevent easy unintended alternate paths. Local relay uses TCP TLS-passthrough and refuses unknown SNI; no HTTP decryption or custom root certificate.
- A route is added only if public DoT (correct CA, hostname, all four RR types), **RU-to-foreign TLS**, original Gemini and old VPN/HTTPS canaries, fail-closed rollback and resource limits all pass.
- If any route in a proposed release fails, return the whole transaction to the previous known-good configuration and split the cohort instead of disabling tests.

## Boundaries and follow-up design

1. Keep Russian-only and sensitive destinations (`gosuslugi.ru`, `nalog.ru`, banks, `yandex.ru`, etc.) on their normal DNS and direct data path.
2. Do not advertise an unrestricted VPN substitute: selective DNS+SNI works only when the client can reach foreign port 443 and the original visible SNI is not filtered. For sites where SNI to foreign IP still times out, a separate **outer authenticated TLS tunnel** or supported app VPN mode is needed — Android Private DNS alone cannot provide that; do not covertly decrypt HTTPS.
3. Check full service hostname inventory only from consented client diagnostics or authoritative documentation, never derive and publish user tokens, cookies or private browsing history.
4. The public resolver has no per-account authentication, and existing resource ceilings are not per-client rate limits. Before mass enablement add identity, quotas, monitoring, abuse policy, regional redundancy and automatic rollback based on error budgets.

Do not treat this document as deployment confirmation: use the current CI/workflow run and direct client tests.
