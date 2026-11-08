# Android Private DNS + MNEBYVPN: compatibility diagnosis

**Status 2026-11-08: failure reproduced by a real user, but not reproduced on this specific Android VPN connection in automation. Root cause not confirmed.**

Facts:
- Android Private DNS `dns.mnebyvpn.site` works while VPN is off.
- With the user's active VPN, Android reports a DNS connection error and opens system DNS settings.
- Independently, the hostname has a trusted certificate, public DoT TLS 1.3 responds; the foreign and RU VPS can connect to it over TCP 853. [Read-only diagnosis](https://github.com/grunvald91/telegram-proxy-infra/actions/runs/42458298895). **This is not a direct test of the user's device VPN session.**

## Android / client design implication

Android VpnService can set DNS servers and routes for the VPN interface. A VPN app's DNS interception, separate resolver or proxy rules may differ from system Private DNS. We must not guess the user's installed client or modify a VPN subscription without observing its actual routing.

The MNEBYVPN onboarding currently recommends **INCY** on Android (not proof that the user's current app is INCY). INCY's own documented routing profiles support RemoteDNSType `DoH` or `DoU`; Private DNS `dns.mnebyvpn.site` is **DoT only**, not a DoH URL. Do not set `https://dns.mnebyvpn.site/dns-query` in INCY yet: that endpoint is not deployed or verified. The INCY routing profile supports `ProxySites`, `DirectSites` and `FakeDNS`; adjusting it requires device-specific testing, not speculative mass replacement.

## Acceptance gates for seamless simultaneous use

1. Identify the actual app/version and whether the transport is VPN TUN, proxy mode or an alternative. Capture only sanitized diagnostics: whether the client attempts `TCP/853`, VPN route and tunnel's DNS mode; **never a customer subscription URL, token or VPN secret**.
2. With system Private DNS held at `dns.mnebyvpn.site`, measure VPN OFF -> ON -> OFF on Wi-Fi and mobile data. Check strict DoT TLS, site loading, IPv6 and direct leakage. Confirm the **same private DNS setting** remains in place; no hidden downgrade to cleartext UDP/53.
3. If a particular VPN client blocks/tunnels DoT incorrectly, fix its protected TCP 853 path, choose a supported client that preserves it or build a compatible integrated DNS engine. A server-side port change alone cannot make Android's strict Private DNS use a different port.
4. If a client requires DoH inside the tunnel, build and verify a **separate authenticated HTTPS DoH gateway**. Do not label a DoT hostname as a working DoH endpoint. Test that it does not compete with the existing foreign TCP 443 listener.
5. To preserve Google availability when VPN is active, INCY `ProxySites` can conditionally include verified Google domain categories; this affects **VPN egress**, not the Android Private DNS error, and may not satisfy Google's regional/account restrictions.
6. Do not remove Android Private DNS or downgrade to insecure DNS as the permanent product solution. For diagnosis only, temporary Android `Automatic` may isolate whether the client itself blocks strict DoT; restore original setting afterwards.

Official sources: https://developer.android.com/reference/android/net/VpnService.Builder ;
https://github.com/INCY-DEV/incy-docs/blob/main/ru/dev-docs/routing.md ;
https://developers.google.com/speed/public-dns/docs/dns-over-tls/ .
