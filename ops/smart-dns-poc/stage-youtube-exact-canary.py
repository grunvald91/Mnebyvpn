#!/usr/bin/env python3
"""Stage, but NEVER install, exact two-host YouTube HTTPS/SNI and DoT pilot.

This compiler assumes live Gemini + three Discord routes. It stages an
additive shared-Nginx 443 SNI map overlay, a separate localhost-only relay
and two exact DNS rewrites for *later* independently authorized rollout.

Staging is not proof of either Russian ingress or YouTube video playback.
"""
from __future__ import annotations

import argparse
import ipaddress
import pathlib
import re

HOSTS = ("www.youtube.com", "youtubei.googleapis.com")
LISTENER = "127.0.0.1:15448"
MAP = re.compile(
    r"(map\s+\$ssl_preread_server_name\s+\$direct_mtproxy_backend\s*\{)"
    r"([^{}]*)(\})", re.S
)
DNS_ANCHOR = "    cache 30\n"
EXISTING = ("gemini.google.com", "discord.com",
            "gateway.discord.gg", "cdn.discordapp.com")
RECORD_TYPES = ("A", "AAAA", "CNAME", "HTTPS", "SVCB")


def require_foreign_public_ipv4(value: str) -> str:
    addr = ipaddress.ip_address(value)
    if not isinstance(addr, ipaddress.IPv4Address) or not addr.is_global:
        raise ValueError("Ingress must be a global IPv4, not a private/local address")
    return str(addr)


def staged_sni(previous: str) -> str:
    maps = list(MAP.finditer(previous))
    if len(maps) != 1:
        raise ValueError("Cannot uniquely identify the shared 443 SNI map")
    part = maps[0]
    body = part.group(2)
    if not re.search(r"(?m)^\s*default\s+[^;]+;\s*$", body):
        raise ValueError("Shared map default missing")
    for existing in EXISTING:
        if not re.search(r"(?m)^\s*" + re.escape(existing) + r"\s+[^;]+;\s*$", body):
            raise ValueError("Known live route not preserved: "+existing)
    for host in HOSTS:
        if re.search(r"(?m)^\s*" + re.escape(host) + r"\s+[^;]+;\s*$", body):
            raise ValueError("Refusing preexisting YouTube shared SNI route")
    insertion = "\n" + "".join(
        "        " + host + " " + LISTENER + ";\n" for host in HOSTS
    )
    updated = previous[:part.start(2)] + insertion + previous[part.start(2):]
    if updated.replace(insertion, "", 1) != previous:
        raise AssertionError("Shared map not changed exclusively by adding exact rules")
    return updated


def dns_template(host: str, rrtype: str, foreign_ip: str) -> str:
    regex = "^" + re.escape(host).replace(r"\.", "[.]") + "[.]$"
    answer = (
        '        answer "{{ .Name }} 20 IN A ' + foreign_ip + '"\n'
        if rrtype == "A" else "        rcode NOERROR\n"
    )
    return (
        "    template IN " + rrtype + " " + host + " {\n"
        "        match " + regex + "\n"
        + answer +
        "        fallthrough\n"
        "    }\n"
    )


def staged_dns(previous: str, foreign_ip: str) -> str:
    ip = require_foreign_public_ipv4(foreign_ip)
    if previous.count(DNS_ANCHOR) != 1:
        raise ValueError("Unexpected CoreDNS cache anchor")
    for existing in EXISTING:
        if previous.count("template IN A " + existing + " {") != 1:
            raise ValueError("Missing known live exact DNS policy: " + existing)
    for host in HOSTS:
        for q in RECORD_TYPES:
            if "template IN " + q + " " + host + " {" in previous:
                raise ValueError("YouTube DNS rewrite already present")
    insertion = "\n    # Not approved until RU TLS and Android playback canaries pass\n"
    for host in HOSTS:
        for q in RECORD_TYPES:
            insertion += dns_template(host, q, ip)
    result = previous.replace(DNS_ANCHOR, insertion + DNS_ANCHOR, 1)
    if result.replace(insertion, "", 1) != previous:
        raise AssertionError("CoreDNS changes other than two exact hostnames")
    return result


def sidecar() -> str:
    entries = "".join(
        "        " + host + " " + host + ":443;\n" for host in HOSTS
    )
    return (
        "# Experimental local-only SNI passthrough; no production listener\n"
        "load_module /usr/lib/nginx/modules/ngx_stream_module.so;\n"
        "worker_processes 1;\n"
        "pid /run/mnebydns-youtube/nginx.pid;\n"
        "error_log stderr warn;\n"
        "events { worker_connections 96; }\n"
        "stream {\n"
        "    resolver 9.9.9.9 ipv6=off valid=30s;\n"
        "    resolver_timeout 3s;\n"
        "    map $ssl_preread_server_name $youtube_exact_target {\n"
        "        default 127.0.0.1:1;\n"
        + entries +
        "    }\n"
        "    server {\n"
        "        listen " + LISTENER + ";\n"
        "        ssl_preread on;\n"
        "        proxy_pass $youtube_exact_target;\n"
        "        proxy_connect_timeout 5s;\n"
        "        proxy_timeout 90s;\n"
        "        proxy_buffer_size 16k;\n"
        "        access_log off;\n"
        "    }\n"
        "}\n"
    )


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--existing-nginx", required=True)
    p.add_argument("--existing-corefile", required=True)
    p.add_argument("--foreign-ip", required=True)
    p.add_argument("--out-dir", required=True)
    args = p.parse_args()
    out = pathlib.Path(args.out_dir)
    if (out.parent != pathlib.Path("/tmp") or
            not re.fullmatch(r"mnebydns-ci-[0-9]+", out.name) or
            out.exists() or out.is_symlink()):
        raise SystemExit("Only a fresh ephemeral /tmp/mnebydns-ci-<id> directory is allowed")
    nginx_file = pathlib.Path(args.existing_nginx)
    dns_file = pathlib.Path(args.existing_corefile)
    if (not nginx_file.is_file() or not dns_file.is_file()
            or nginx_file.is_symlink() or dns_file.is_symlink()):
        raise SystemExit("Inputs must be regular, non-symlink configuration snapshots")
    # Compile ALL contents before creating output; errors leave no stage behind.
    n = staged_sni(nginx_file.read_text(encoding="utf-8"))
    d = staged_dns(dns_file.read_text(encoding="utf-8"), args.foreign_ip)
    relay = sidecar()
    out.mkdir(mode=0o700)
    for name, data in (
        ("nginx.shared.staged", n),
        ("Corefile.staged", d),
        ("youtube.loopback.nginx.conf", relay),
    ):
        with (out / name).open("x", encoding="utf-8") as f:
            f.write(data)
        (out / name).chmod(0o600)
    print("youtube_exact_host_count=2")
    print("staging_only_no_network_changes=yes")
    print("original_Nginx_and_CoreDNS_snapshots_untouched=yes")
    print("Russian_to_foreign_original_TLS_before_public_DNS=REQUIRED")
    print("Android_video_and_application_test=REQUIRED")


if __name__ == "__main__":
    main()
