# MNEBYDNS Google selective HTTPS routing — first stage

**2026-11-08: ISOLATED SNI PROTOTYPE. NOT DEPLOYED TO PUBLIC TCP/443. NO DNS REWRITE ACTIVE.**

The goal is to send selected Google TCP/TLS connections from a user device to the foreign VPS while keeping application-to-Google TLS end-to-end. Merely forwarding encrypted DNS does **not** change the website-observed client IP. Public DNS at `dns.mnebyvpn.site:853` is currently a normal encrypted resolver only.

## Before any production DNS rewrite

1. Use an exact, verified list of hostnames; do not route `*.google.com`, `*.googleapis.com` or all Google by a single DNS suffix blindly. Google applications rely on many API, static, media, OAuth, CNAME and regional hosts.
2. On the foreign VPS, test **only** a temporary independent loopback stream proxy, port **15443**, without changing the shared Nginx 443 stream. `Google-SNI-staging.nginx.conf` denies any unknown SNI by sending it to a closed loopback port; it never proxies arbitrary hostnames or arbitrary IPs.
3. Via external test client or isolated tunnel, verify TLS certificate for each original Google hostname, HTTPS response and foreign server's egress. Test unknown SNI refusal. Staging is not evidence that direct user traffic is already rerouted.
4. Record `A`, `AAAA`, `CNAME`, `HTTPS/SVCB`, DNSSEC, IPv6, QUIC/HTTP3 and ECH behavior per hostname. DNS rewrite must never result in Google connections going directly on an unintended address family or a broken TLS certificate. Never install a custom certificate authority or intercept HTTPS.
5. Only once ready should a carefully reviewed atomic change to the **existing** shared ingress TCP/443 SNI map be proposed. It must preserve every pre-existing VPN/Telegram Nginx stream route, carry a complete config backup, provide `nginx -t`, canary probes and immediate automatic rollback. The foreign VPS currently has port 443 in use; a new 443 listener would conflict.
6. After the SNI map supports a verified hostname, update the DNS policy for that hostname **only**, handling all RR types consistently, and prove from an external test phone that the Google origin sees foreign egress. Unknown Google hosts must not be rewritten.
7. When Android Private DNS fails in combination with a VPN, check the VPN app's own DNS engine, routing and whether TCP/853 is tunneled, blocked or bypassed. Endpoint reachability from an external test runner or control-plane VPS does not prove the client's tunneled path.

## Scope of the first 8 exact-host SNI lab rules

`gemini.google.com`, `aistudio.google.com`, `generativelanguage.googleapis.com`, `labs.google`, `accounts.google.com`, `www.google.com`, `www.youtube.com`, `www.gstatic.com`.

These are candidates for independent test, **not** a claim that they make every Google service work. Some support resources live on other hostnames.

Reference: https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html and https://coredns.io/plugins/template/. Android VPN DNS API: https://developer.android.com/reference/android/net/VpnService.Builder .
