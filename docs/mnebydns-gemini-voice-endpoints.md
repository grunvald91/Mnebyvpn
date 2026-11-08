# Gemini voice follow-up — network-only canary

**2026-11-08 (08:48 UTC): two additional Gemini application hostnames are LIVE on public MNEBYDNS, but actual Android voice request success is NOT YET VERIFIED.**

## What the user observed

With VPN off and Android Private DNS set to `dns.mnebyvpn.site`, `gemini.google.com` loaded. Voice prompts failed both in a browser and in built-in Android Gemini. No region-unavailable warning appeared. This does not conclusively distinguish DNS, authorization, browser speech recognition, microphone permissions or account eligibility.

## Grounded host inventory

Google officially names `jnn-pa.googleapis.com` and `waa-pa.clients6.google.com` as Gemini app endpoints. Source, updated 2026-10-26: https://knowledge.workspace.google.com/admin/generative-ai/gemini-app/gemini-app-firewall-settings . No source confirms that one particular host carries a specific user's voice request; network routing remains a staged hypothesis.

## What was deployed

- An additional independent bounded `mnebydns-gemini-aux.service` listens only on `127.0.0.1:15444`, forwarding exact original TLS by SNI to these two hostnames. Original Gemini relay on 15443 is unchanged.
- Main foreign Nginx SNI map received two additive exact entries to the auxiliary relay; 27 previous routes including Gemini retained.
- Public DoT on 853 returns foreign VPS `89.125.90.101` only for the two added hostnames; each synthetic A has 20-second max TTL and AAAA/HTTPS/SVCB return NODATA. Other domain lookups remain forwarded over authenticated DoT to Quad9.
- User communication, origin Google TLS and HTTP data remain encrypted; the relay never installs a custom CA or decrypts application traffic.
- A transaction-specific backup, recovery watchdog and original config comparisons ensure the change can be rolled back without replacing unrelated Nginx/VPN routes.

## Evidence

- 12-host connectivity comparison: foreign TLS success for all; Russian VPS success for 11 of 12, and `play.google.com` timed out in that sample. This does **not** establish voice-host ownership. https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42464062689
- Isolated CoreDNS 1.15.0 A/AAAA/HTTPS/SVCB and unchanged baseline domains green: https://github.com/grunvald91/Mnebyvpn/actions/runs/42464324050
- Dedicated loopback TLS relay certificates verified, unknown SNI rejected: https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42464182030
- Live Russian-side original Google certificate and baseline 443 routes green; public DoT A/AAAA/HTTPS/SVCB green; watchdog disarmed after success: https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42464486729

## Next on-device acceptance

With INCY VPN **off**, system Android Private DNS still `dns.mnebyvpn.site`, verify a simple text prompt on gemini.google.com, a short voice dictation prompt from the browser, and short built-in Android Gemini speech. Record separately: (1) text succeeded, (2) voice transcribed but answer failed, (3) voice did not transcribe, (4) exact error code/screenshot. Never capture or upload Google account tokens, cookies or unredacted full packet captures.

## Open limitations

The listed official Gemini firewall requirements include many additional hostnames (e.g., www.googleapis.com, optimizationguide-pa.googleapis.com, play.google.com, apis.google.com), but there is no basis yet to redirect every Google endpoint indiscriminately. Native Android recognition may require separate Google app/Play services endpoints. A TLS successful handshake does not guarantee application authorization, voice WebSocket/UDP transport, regional eligibility or user account permission. Browser secure DoH, cached DNS and QUIC HTTP/3 might bypass this TCP SNI relay; check if failures continue.

Google consumer troubleshooting: https://support.google.com/gemini/answer/18647528