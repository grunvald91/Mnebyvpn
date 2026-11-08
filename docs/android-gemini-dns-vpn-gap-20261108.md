# Android Gemini: working VPN+Private DNS vs failing Private DNS alone (2026-11-08)

## User-supplied reproduction

- Android with VPN **enabled** together with system Private DNS: Gemini works.
- Android with VPN **disabled** and system Private DNS still configured: Gemini fails.
- Clarify which operation succeeds independently (Gemini text, browser voice and Android native voice); a single positive result does not prove all three.

This observation cannot prove Private DNS still handles queries while the VPN is enabled. Some VPN configurations select their own DNS resolvers. Also, changing a DNS answer does not guarantee that TCP/UDP traffic uses a foreign egress address.

## Live evidence

[Read-only authenticated-DoT audit run #42489604676](https://github.com/grunvald91/Mnebyvpn/actions/runs/42489604676), executed against the actual public MNEBYDNS (no production change):

- 34 hostnames from [Google's official Gemini App firewall list](https://knowledge.workspace.google.com/admin/generative-ai/gemini-app/gemini-app-firewall-settings).
- **1 of 34** (gemini.google.com) returned the foreign HTTPS ingress A address. Others returned normal upstream/IPv6 responses; one was inconclusive.
- **0 of 12** tested Google Android system hosts returned the foreign HTTPS ingress address. Some ordinary DNS queries were inconclusive.
- Three exact Discord control routes remained foreign-ingress synthetic and valid.
- The test did not inspect any user's real Android traffic, account information, query contents, YouTube stream or Gemini voice payload.

### Why broad public DNS rewriting is not a safe universal fix

Google documents FCM/push connectivity over TCP ports 5228-5230 and other Android dependencies. MNEBYDNS's staged SNI proxy listens on TCP/443 only; rewriting non-443 Google domains to that IP may break core Android notification services. FCM also explicitly documents limitations of network proxies. QUIC/UDP443 and app-local DNS are different unhandled paths. Google device/account/SIM/region eligibility still applies.

Sources: https://firebase.google.com/docs/cloud-messaging/network-configuration ; https://support.google.com/work/android/answer/10513641 ; https://developers.google.com/speed/public-dns/docs/using

## Prototype opt-in Google app selective routing

INCY supports provider-controlled per-app VpnService via subscription HTTP response headers:
- per-app-proxy-enable: 1
- per-app-proxy-mode: proxy
- per-app-proxy-list: comma-separated Google/Gemini/system package IDs

Official client documentation: https://docs.incy.cc/app-management/

This project adds an optional user-visible Android Google-mode importer, **never** changes the legacy subscription, and only sends the above headers for a node-verified `?client=incy&mode=google` request. This mode carries selected Google app traffic through the *same already working VPN transport*, including non-443 TCP, instead of trying to proxy their IPs through DNS alone. Unknown or non-installed packages must be handled by the INCY client; verify on the user's device.

In this mode Android still displays a VPN icon. Other apps bypass the VPN by design. Google's [Android Enterprise](https://support.google.com/work/android/answer/9213914) warns that enabling **Block connections without VPN** together with an allowed-app-only list disconnects applications not on that list. The service warns against this combination. No automatic direct fallback is claimed safe.

## Validation matrix

| INCY Android | Android Private DNS | Result to record |
| --- | --- | --- |
| OFF | OFF | Baseline: Gemini web text / native text / voice |
| OFF | MNEBYDNS | DNS-only reproduction: three independent operations |
| ON full-tunnel | OFF | VPN-only control, isolates the DNS effect |
| ON full-tunnel | MNEBYDNS | Existing working combination |
| ON selective Google-mode | MNEBYDNS | Opt-in: native Gemini text/voice; YouTube; other apps direct |

For each case note network type (Wi-Fi/mobile), exact app and specific error only. Do not capture tokens, signed URLs, cookies, voice recordings or packet payloads. Once the selective mode is imported, check that it stays across a subscription refresh and that the system apps are visible in the list.

**Not proof of a live mobile fix:** source code, unit tests and offline subscription bridge tests are not device tests. No Android software was installed by this change; no production route, Nginx, Xray or TLS listener changed.
