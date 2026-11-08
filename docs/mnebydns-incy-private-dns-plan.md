# MNEBYVPN + INCY + Android Private DNS

Date 2026-11-08. **One user-confirmed failure:** Android's Private DNS `dns.mnebyvpn.site` works when INCY VPN is off but Android reports a Private DNS connection error when INCY VPN is on. **Root cause not reproduced from the affected phone.**

## What INCY's official docs prove

- INCY's routing profiles distinguish `RemoteDNSType` and `DomesticDNSType` (`DoH` or `DoU`), plus `DirectSites`, `DirectIp`, `ProxySites`, `ProxyIp`, and `FakeDNS`.
- The public `dns.mnebyvpn.site:853` service is **DoT**, not DoH, so it must NOT be inserted into the INCY `RemoteDNSDomain` as `https://dns.mnebyvpn.site/dns-query`. That URL is not deployed.
- INCY provides a VPN DNS public preset and distinct `FakeDNS` policy. When changing VPN DNS policy, reconnect the VPN, and restart apps that might cache DNS.
- Full Xray JSON profiles (both `inbounds` and `outbounds`) have their own DNS servers; altering an ordinary routing-profile JSON will not necessarily affect them.

Official INCY documentation:
https://github.com/INCY-DEV/incy-docs/blob/main/ru/dev-docs/routing.md
https://github.com/INCY-DEV/incy-docs/blob/main/ru/dev-docs/full-xray-config.md
Android VpnService: https://developer.android.com/reference/android/net/VpnService.Builder

## First phone test — no subscription modification

1. Leave Android **Private DNS** pinned to `dns.mnebyvpn.site`.
2. Note current INCY version and whether `VPN DNS` is Internal/Public. Do not share subscription tokens.
3. Switch INCY `VPN DNS` to **Public** temporarily and set the active routing profile's `FakeDNS` to **false** if applicable. This is a diagnostic configuration from the vendor documentation, not a proven fix.
4. Disconnect/reconnect INCY; check Android status and a normal page. Repeat VPN off/on/off. If it fails again, undo the trial changes; record a sanitized INCY log and whether strict Private DNS is still enabled.
5. Check that Google and Russia-direct sites behave as intended. A site loading does not certify lack of DNS leaks; verify separately. Never change Android Private DNS to automatic as a *permanent* workaround.

## Second opt-in stage (if needed)

`packages/dns-policy/src/incy-compatibility.ts` can **stage** a copy of an existing INCY routing profile with two additional direct rules:
- `DirectSites`: `dns.mnebyvpn.site`
- `DirectIp`: `89.125.90.101/32`

This might help a client that mistakenly sends the Android DoT connection through its own tunnel; it is **not a proven fix**, and directing `89.125.90.101/32` outside the VPN affects **all destinations on that one server IP**, not just port 853. DNS content remains TLS-protected, but network observers can see connections to the DNS endpoint. The builder leaves existing remote/domestic DNS and GlobalProxy choices unchanged, refuses any existing `ProxyIp` rule or contradictory `ProxySites`, and will not touch live subscriptions or automatically import into any user's app. Review and opt in with a backup only after confirming exact client behavior.

If the issue is a VPN TUN or Android strict DNS incompatibility, only targeted client tests can establish the fix. The public DoT server is already TLS validated and independently reachable; no server firewall/TLS changes are justified from this symptom alone.

## Google

Google TLS passthrough was validated separately on foreign loopback, but no production DNS rewrites exist. An INCY routing profile can steer Google **through the already-active VPN**, which is a different solution from Smart DNS when VPN is off. Both need independent Android E2E tests. Neither is guaranteed by this compatibility file.
