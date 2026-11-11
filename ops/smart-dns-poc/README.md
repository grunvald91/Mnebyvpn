# MNEBYDNS — isolated DoT resolver experiment (stage 1)

**Status:** opt-in testbed in a feature branch; **not deployed**. No Smart DNS site routing, IPv6 subscriber identity, quota, authentication, public service or Android compatibility is implemented here.

This stage is deliberately narrow: verify that a version-pinned CoreDNS instance can accept **DNS-over-TLS**, forward queries to an encrypted upstream and stay isolated from production ports/services. DoT protects only DNS queries between client and resolver; it does **not** change the website-observed IP or bypass blocking by itself.

## Run locally or on a separately approved test VPS

Prerequisites: Docker Compose, OpenSSL, kdig (knot-dnsutils), outbound TCP/853 to 9.9.9.9. This config binds **host loopback 127.0.0.1:1853 TCP only** (not host 53/443/853). CoreDNS inside the container uses 8853 TCP.

From repository root:

~~~bash
bash ops/smart-dns-poc/preflight.sh
sudo bash ops/smart-dns-poc/make-local-cert.sh
docker compose -f ops/smart-dns-poc/compose.yaml config
docker compose -f ops/smart-dns-poc/compose.yaml up -d
python3 ops/smart-dns-poc/probe-dot.py
docker compose -f ops/smart-dns-poc/compose.yaml stats --no-stream
docker compose -f ops/smart-dns-poc/compose.yaml down
~~~

The test certificate is self-signed, short-lived and for dns.test.invalid; **it cannot be used as an Android Private DNS hostname certificate**. The private key stays local, is ignored by Git and should be deleted after the test. Local test success requires a real TLS-authenticated DNS query through `probe-dot.py` (including certificate-hostname rejection); a green config/unit check alone is not proof. The test image runs as nonroot UID 65532; its private key remains owner-read-only. The test does not validate a public Android service. The Docker memory cap of 128 MiB is a safety boundary for this *test*, not a measured system requirement or a throughput guarantee.

## Hard stops before a public/mobile test

1. Take a **fresh read-only VPS baseline** (CPU/RAM/disk/latency, 53/443/853 port map, peak proxy usage), confirm margin and backup/rollback.
2. Obtain a dedicated controlled DNS hostname and valid publicly trusted certificate. Android Private DNS uses a **hostname**, normally over **TCP/853**; this staging port is **not** directly usable by Android.
3. Design an anti-abuse/access policy before binding any public port. This laboratory has no per-subscriber authentication or rate-limit perimeter, and **must not** become an open recursive resolver.
4. Establish client-level compatibility matrix: Android with VPN off/on/off, mobile data/Wi-Fi, DNS leaks, app-specific DNS overrides; no silent failure or disabled TLS verification.
5. Smart DNS *HTTPS traffic rerouting* is **stage 2** with a strict allowed-domain SNI ingress. It must be separately network-isolated and audited for auth, revocation, QUIC/ECH, original TLS verification and subscription quota. Never infer access control from a DNS token or TTL.

Do not modify any live 443/853 listener, Nginx, Xray, firewall, certificates or existing proxies during this experiment. See [Smart DNS design](../../docs/smart-dns.md), [privacy/Android compatibility ADR](../../docs/decisions/0006-private-dns-vpn-privacy-performance-egress.md), and [release gates](../../docs/release-gates.md).

Upstream/CoreDNS references:
- https://coredns.io/plugins/tls/
- https://coredns.io/plugins/forward/
- https://github.com/coredns/coredns/releases/tag/v1.15.0
- https://developers.google.com/speed/public-dns/docs/using
