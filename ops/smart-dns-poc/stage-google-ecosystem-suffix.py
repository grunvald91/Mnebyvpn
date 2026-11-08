#!/usr/bin/env python3
"""STAGING ONLY: ecosystem-wide Google/YouTube SmartDNS and original TLS/SNI.

Always compile exact Google-owned domain suffixes from a bounded static policy.
Do NOT offer a generic arbitrary-SNI open proxy. Never alters active services.
Google account/GPS/SIM/browser DoH/QUIC can still expose the user's location.
"""
from __future__ import annotations

import argparse
import ipaddress
import pathlib
import re

# Google-owned product hostnames and media/SDK infrastructure groups.
# Domain suffix = apex plus all subdomains. No unverified third-party CDNs.
SUFFIXES = (
    "google.com",
    "google.ru",
    "google.de",
    "google.co.uk",
    "googleapis.com",
    "gstatic.com",
    "googleusercontent.com",
    "googlevideo.com",
    "youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "ytimg.com",
    "ggpht.com",
    "withgoogle.com",
    "googletagmanager.com",
    "google-analytics.com",
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "gvt1.com",
    "gvt2.com",
    "gvt3.com",
)
# The existing root Gemini route, the three Discord routes and other
# existing shared SNI entries MUST remain intact.
PRESERVED = (
    "gemini.google.com",
    "discord.com",
    "gateway.discord.gg",
    "cdn.discordapp.com",
)
LOCAL_SNI = "127.0.0.1:15449"
LOCAL_ORIGIN_DNS = "127.0.0.1:5354"
INGRESS = "89.125.90.101"
NGINX_MAP = re.compile(
    r"(map\s+\$ssl_preread_server_name\s+\$direct_mtproxy_backend\s*\{)"
    r"([^{}]*)(\})", re.S
)
CACHE_ANCHOR = "    cache 30\n"
RR = ("A", "AAAA", "CNAME", "HTTPS", "SVCB")

# A DNS-only catchall CANNOT forward protocols other than TLS-over-TCP/443.
# Google explicitly uses non-443 endpoints for Android notifications and NTP.
# These are release blockers until a compatible client transport exists.
# https://firebase.google.com/docs/cloud-messaging/network-configuration
# https://support.google.com/work/android/answer/10513641
NON_HTTPS_BLOCKERS = (
    "mtalk.google.com",
    "mtalk4.google.com",
    "alt1-mtalk.google.com",
    "time.google.com",
    "stun.l.google.com",
)
LAB_ONLY = True


def matches_managed_suffix(host: str) -> bool:
    name = host.rstrip(".").lower()
    return any(name == zone or name.endswith("." + zone) for zone in SUFFIXES)


def require_no_overlapping_google_exact(body: str) -> None:
    """Prevent an existing exact Google SNI route shadowing our suffix route.

    Only the historically verified root Gemini handler can be preserved without
    another explicit live-route audit. A prior www.google.com exact entry is
    NOT proof that it forwards valid Google TLS after a new public DNS rewrite.
    """
    approved = {"gemini.google.com": "127.0.0.1:15443"}
    for line in body.splitlines():
        parsed = re.fullmatch(
            r"\s*([^\s;#]+)\s+([^\s;#]+);\s*(?:#.*)?", line
        )
        if not parsed:
            continue
        name, destination = parsed.groups()
        if name == "default":
            continue
        if name.startswith("~"):
            # Earlier regex entries retain their original priority and are
            # never overwritten. Arbitrary PCRE overlaps still need a live
            # configuration review; do not interpret lab PASS as full reach.
            continue
        # Nginx mask names take precedence over ANY regex. A previously
        # installed *.google.com, .youtube.com or even *.com rule could
        # silently shadow our new broad Google suffix route.
        if name.startswith("*.") or name.startswith("."):
            zone = name[2:] if name.startswith("*.") else name[1:]
            if any(suffix == zone.lower() or suffix.endswith("." + zone.lower())
                   for suffix in SUFFIXES):
                raise ValueError("Existing Google-overlapping SNI wildcard mask: " + name)
            continue
        if name.endswith(".*"):
            prefix = name[:-1].lower()
            samples = (
                "www.google.com", "www.youtube.com", "www.googleapis.com",
                "gemini.google.com", "i.ytimg.com",
            )
            if any(host.startswith(prefix) for host in samples):
                raise ValueError("Existing Google-overlapping SNI prefix mask: " + name)
            continue
        if "*" in name:
            raise ValueError("Unknown SNI mask syntax requires manual review: " + name)
        if matches_managed_suffix(name):
            if approved.get(name.lower()) != destination:
                raise ValueError(
                    "Unreviewed exact Google SNI route would shadow "
                    f"suffix policy: {name} => {destination}"
                )



def validate() -> None:
    if len(set(SUFFIXES)) != len(SUFFIXES):
        raise ValueError("duplicate Google suffix")
    for suffix in SUFFIXES:
        if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", suffix):
            raise ValueError("unexpected suffix")
        if suffix == "com" or suffix in ("ru", "net", "org"):
            raise ValueError("public suffix as proxy target forbidden")
    ip = ipaddress.ip_address(INGRESS)
    if not isinstance(ip, ipaddress.IPv4Address) or not ip.is_global:
        raise ValueError("foreign ingress must be global IPv4")


def suffix_pattern(nginx: bool = False) -> str:
    """Anchored RE2/PCRE-compatible regex, never a substring match."""
    validate()
    labels = "|".join(
        re.escape(zone).replace(r"\.", r"\.") if nginx
        else re.escape(zone).replace(r"\.", "[.]")
        for zone in SUFFIXES
    )
    return (
        r"^(?:[a-z0-9-]+\.)*(?:" + labels + r")$"
        if nginx else
        r"^(?:[a-z0-9-]+[.])*(?:" + labels + r")[.]$"
    )


def shared_sni(original: str) -> str:
    matches = list(NGINX_MAP.finditer(original))
    if len(matches) != 1:
        raise ValueError("refuse unrecognized shared SNI map")
    block = matches[0]
    body = block.group(2)
    if not re.search(r"(?m)^\s*default\s+\S+;", body):
        raise ValueError("shared 443 default is missing")
    for host in PRESERVED:
        if len(re.findall(r"(?m)^\s*" + re.escape(host) + r"\s+\S+;", body)) != 1:
            raise ValueError("existing live route missing/duplicated: "+host)
    require_no_overlapping_google_exact(body)
    if "127.0.0.1:15449" in original:
        raise ValueError("ecosystem proxy already configured")
    # Nginx evaluates regexp maps in order; place our broad fallback LAST.
    # ~* makes SNI matching case-insensitive (DNS names are case-insensitive).
    insertion = "\n        ~*" + suffix_pattern(nginx=True) + " " + LOCAL_SNI + ";\n"
    result = original[:block.end(2)] + insertion + original[block.end(2):]
    if result.replace(insertion, "", 1) != original:
        raise AssertionError("shared SNI transform must be additive")
    return result


def public_dot(original: str) -> str:
    validate()
    if original.count(CACHE_ANCHOR) != 1:
        raise ValueError("DNS Corefile cache marker missing or duplicated")
    for host in PRESERVED:
        if original.count("template IN A " + host + " {") != 1:
            raise ValueError("existing Gemini or Discord route missing: "+host)
    if "# MNEBYDNS ecosystem-wide Google DNS rewrite" in original:
        raise ValueError("ecosystem DNS policy already present")
    # Go regexp supports inline (?i); DNS query names are case-insensitive.
    pattern = "(?i)" + suffix_pattern(nginx=False)
    inserted = "\n    # MNEBYDNS ecosystem-wide Google DNS rewrite, staged only\n"
    for q in RR:
        ans = (
            f'        answer "{{{{ .Name }}}} 20 IN A {INGRESS}"\n'
            if q == "A" else "        rcode NOERROR\n"
        )
        inserted += (
            f"    template IN {q} . {{\n"
            f"        match {pattern}\n"
            + ans +
            "        fallthrough\n"
            "    }\n"
        )
    result = original.replace(CACHE_ANCHOR, inserted + CACHE_ANCHOR, 1)
    if result.replace(inserted, "", 1) != original:
        raise AssertionError("CoreDNS transform must be strictly additive")
    return result


def proxy_config(pid_path: str) -> str:
    if not re.fullmatch(r"/tmp/mnebydns-ci-[0-9]+/nginx.pid", pid_path):
        raise ValueError("staging-only pid path required")
    return (
        "# STAGING ONLY: exact Google-owned suffixes; no public listener.\n"
        "load_module /usr/lib/nginx/modules/ngx_stream_module.so;\n"
        "worker_processes 1;\n"
        "pid " + pid_path + ";\n"
        "error_log stderr warn;\n"
        "events { worker_connections 96; }\n"
        "stream {\n"
        "    # Isolated local DNS resolver -> authenticated foreign Quad9 DoT.\n"
        "    resolver " + LOCAL_ORIGIN_DNS + " ipv6=off valid=20s;\n"
        "    resolver_timeout 5s;\n"
        "    map $ssl_preread_server_name $google_origin {\n"
        "        default 127.0.0.1:1;\n"
        "        ~*" + suffix_pattern(nginx=True) + " $ssl_preread_server_name:443;\n"
        "    }\n"
        "    server {\n"
        "        listen " + LOCAL_SNI + ";\n"
        "        ssl_preread on;\n"
        "        proxy_pass $google_origin;\n"
        "        proxy_connect_timeout 7s;\n"
        "        proxy_timeout 90s;\n"
        "        proxy_buffer_size 16k;\n"
        "        access_log off;\n"
        "    }\n"
        "}\n"
    )


def origin_dns() -> str:
    """No synthetic answers here: DNS for foreign origin must never recurse."""
    return (
        "# STAGING ONLY: localhost UDP DNS to validated Quad9 upstream over DoT.\n"
        ".:5354 {\n"
        "    bind 127.0.0.1\n"
        "    cache 20\n"
        "    forward . tls://9.9.9.9 tls://149.112.112.112 {\n"
        "        tls_servername dns.quad9.net\n"
        "        policy sequential\n"
        "        failover SERVFAIL\n"
        "        max_connect_attempts 2\n"
        "    }\n"
        "}\n"
    )


def stage(input_nginx: pathlib.Path, input_dot: pathlib.Path, out: pathlib.Path) -> None:
    if (out.parent != pathlib.Path("/tmp")
        or not re.fullmatch(r"mnebydns-ci-[0-9]+", out.name)
        or out.exists() or out.is_symlink()):
        raise ValueError("only a fresh ephemeral CI directory allowed")
    for f in (input_nginx, input_dot):
        if not f.is_file() or f.is_symlink():
            raise ValueError("regular original snapshots required")
    configs = (
        ("shared-nginx.staged", shared_sni(input_nginx.read_text())),
        ("Corefile.staged", public_dot(input_dot.read_text())),
        ("google-ecosystem.nginx.conf", proxy_config(str(out / "nginx.pid"))),
        ("Corefile.origin-resolver", origin_dns()),
    )
    out.mkdir(mode=0o700)
    for name, content in configs:
        item=out / name
        with item.open("x", encoding="utf-8") as output:
            output.write(content)
        item.chmod(0o600)
    print("google_suffix_groups_staged=" + str(len(SUFFIXES)))
    print("youtube_media_and_images_suffixes_present=yes")
    print("gemini_official_google_domains_present=yes")
    print("foreign_origin_DNS_forward_is_encrypted=yes")
    print("unknown_non_Google_SNI_denied=yes")
    print("no_public_or_production_changes=yes")
    print("LAB_ONLY_no_production_release_artifact=yes")
    print("non443_Google_FCM_NTP_STUN_routing_risk=BLOCKER")
    print("QUIC_HTTP3_and_Android_voice_UNVERIFIED=yes")


def main() -> None:
    p=argparse.ArgumentParser()
    p.add_argument("nginx")
    p.add_argument("corefile")
    p.add_argument("out_dir")
    args=p.parse_args()
    stage(pathlib.Path(args.nginx), pathlib.Path(args.corefile),
          pathlib.Path(args.out_dir))


if __name__ == "__main__":
    main()
