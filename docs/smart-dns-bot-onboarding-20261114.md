# Smart DNS: Telegram tariffs, personal profile and devices

Date: 2026-11-14. Four tariff **prices approved**, but this document
does not certify payment activation, public DoT uptime or a particular app.

## Prices and quotas

- 14 days — 100 Telegram Stars; one million DNS queries within 14 days.
- 30 days — 200 Stars; one million queries over 30 days.
- 60 days — 400 Stars; one million queries in each fixed 30-day period.
- 90 days — 500 Stars; one million queries in each fixed 30-day period.

Terms are durations of 24-hour days, not calendar billing months. Quotas
count eligible DNS queries, not bytes or simultaneously connected devices.
Unused queries do not roll over. If the budget ends, customer can purchase a
fresh package, wait for activation and obtain another personal address; an old
credential is not automatically refilled when a new purchase is made.

The migration `0124_smart_dns_four_stars_offers.sql` creates plan rows
disabled. A separate verified release action is needed to enable paid plans.
The bot additionally checks `MNEBYDNS_PERSONAL_DOT_ENABLED=yes`.

## Issuing a personal iOS profile

After a verified payment and real entitlement activation:
1. In @MnebyVPN_bot select **Smart DNS → Получить персональный адрес и файл iOS**.
2. Server validates Telegram identity and entitlement, issues one unpredictable
   DoT hostname; PostgreSQL stores **only its hash**.
3. Bot attempts a `sendDocument` multipart upload of a per-user
   `.mobileconfig`, not a public download URL; no profile remains in git.
4. Document contains only a `com.apple.dnsSettings.managed` DoT configuration,
   with `DNSProtocol=TLS` and `ServerName=<personal hostname>`. No root
   certificate, VPN, MDM enrollment, proxy or device supervision.
5. If upload fails, bot returns the one-time hostname and an explicit warning,
   never a false "file sent" claim. To generate another file, customer must
   explicitly rotate the bearer; old hostname stops working and quota persists.

### iPhone/iPad installation

Apple documents importing a configuration profile from **Safari or Mail**:
open `.mobileconfig` from a trusted website or Mail attachment. If Telegram
only displays it as a file, save/forward privately to the customer's own
Mailbox and open with Mail. Then go to **Settings → Profile Downloaded →
Install**, or **General → VPN & Device Management**. Apple removes an
uninstalled downloaded profile after 8 minutes. Keep it private.

Sources:
- https://support.apple.com/en-ae/102400
- https://support.apple.com/en-in/guide/profile-manager/pmdbd71ebc9/mac
- https://support.apple.com/en-lamr/guide/deployment/dep86469ba99/web

### Android, router and TV

Android: Settings → Network & internet → Private DNS →
Private DNS provider hostname → paste personal DoT hostname.

For routers: only a router with DNS-over-TLS **hostname** and certificate
verification can use a personal DoT identity; plain DNS IP fields are not
equivalent. A TV/console without such feature might use the router's resolver,
but app DNS overrides and hardcoded resolvers can bypass it. Compatibility
must be checked per device.

Source: https://support.google.com/android/answer/9654714

## Supported services: claims policy

Potentially routed domains include YouTube, ChatGPT, Claude, X/Grok,
TikTok, Gemini, Google AI Studio and Oracle Cloud. Working status is network-
and app-dependent and must be verified at time of publication. Do not claim
Instagram or Threads work via DNS. Do not call Smart DNS a VPN or promise
universal access: DNS settings alone do not encrypt all app traffic.

## Prelaunch checks

Before opening sales: apply vetted migration to the real billing DB with
backup, verify external strict DoT/853 on real devices, confirm issuance,
expiration and query counter, successful and failed Telegram profile delivery,
Stars checkout/refund and repeat purchase. No bypass of payment gate.
