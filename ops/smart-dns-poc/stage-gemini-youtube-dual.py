#!/usr/bin/env python3
"""Side-by-side Gemini + YouTube pilot compiler. LOCAL STAGING ONLY.

Only selected exact hostnames with demonstrated Russian network failure and
no observed Russian->foreign SNI timeout may be staged. Never modifies any
live server; deliberately excludes earlier Gemini regressions and risky
hosts that already timed out on the foreign shared 443 SNI ingress.
"""
from __future__ import annotations
import argparse
import importlib.util
import ipaddress
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
SNI_PORT = 15448
SIDECAR = "127.0.0.1:15448"
YOUTUBE = ("www.youtube.com", "youtubei.googleapis.com",
           "i.ytimg.com", "s.ytimg.com")
GEMINI = ("apis.google.com",)
HOSTS = tuple(sorted(YOUTUBE + GEMINI))
QUARANTINED = ("jnn-pa.googleapis.com", "waa-pa.clients6.google.com")
NETWORK_UNCONFIRMED = ("play.google.com", "yt3.ggpht.com")
PRESERVE = ("gemini.google.com", "discord.com",
            "gateway.discord.gg", "cdn.discordapp.com")
RR = ("A", "AAAA", "CNAME", "HTTPS", "SVCB")
INGRESS = "89.125.90.101"
NGINX_MAP = re.compile(
    r"(map\s+\$ssl_preread_server_name\s+\$direct_mtproxy_backend\s*\{)"
    r"([^{}]*)(\})", re.S
)
CACHE = "    cache 30\n"


def target_ip(ip: str) -> str:
    target = ipaddress.ip_address(ip)
    if not isinstance(target, ipaddress.IPv4Address) or not target.is_global:
        raise ValueError("Refuse private, non-public, or IPv6 ingress")
    return str(target)


def render_nginx(original: str) -> str:
    matches = list(NGINX_MAP.finditer(original))
    if len(matches) != 1:
        raise ValueError("Active SNI table must be uniquely recognized")
    m = matches[0]
    body = m.group(2)
    if not re.search(r"(?m)^\s*default\s+[^;]+;", body):
        raise ValueError("Original shared 443 default missing")
    for host in PRESERVE:
        if len(re.findall(r"(?m)^\s*" + re.escape(host) + r"\s+[^;]+;", body)) != 1:
            raise ValueError("Live route missing or duplicated: " + host)
    for host in HOSTS:
        if re.search(r"(?m)^\s*" + re.escape(host) + r"\s+[^;]+;", body):
            raise ValueError("Already active or duplicate pilot route: "+host)
    addition = "\n" + "".join(f"        {name} {SIDECAR};\n" for name in HOSTS)
    result = original[:m.start(2)] + addition + original[m.start(2):]
    if result.replace(addition, "", 1) != original:
        raise AssertionError("Nginx must change only inside exact map")
    return result


def render_dns(original: str, ip: str) -> str:
    target = target_ip(ip)
    if original.count(CACHE) != 1:
        raise ValueError("CoreDNS cache insertion point absent or duplicated")
    for host in PRESERVE:
        if original.count("template IN A " + host + " {") != 1:
            raise ValueError("Existing DNS service route missing: "+host)
    for host in HOSTS:
        for rr in RR:
            if "template IN " + rr + " " + host + " {" in original:
                raise ValueError("Already synthesized DNS route: " + host)
    addition = "\n    # Limited Gemini/YouTube exact-host pilot: no wildcard media domains\n"
    for host in HOSTS:
        safe = "^" + re.escape(host).replace(r"\.", "[.]") + "[.]$"
        for rr in RR:
            answer = (
                f'        answer "{{{{ .Name }}}} 20 IN A {target}"\n'
                if rr == "A" else "        rcode NOERROR\n"
            )
            addition += (f"    template IN {rr} {host} {{\n"
                         f"        match {safe}\n" + answer +
                         "        fallthrough\n    }\n")
    result = original.replace(CACHE, addition + CACHE, 1)
    if result.replace(addition, "", 1) != original:
        raise AssertionError("CoreDNS update must be additive")
    return result


def sidecar() -> str:
    routes = "".join(f"        {host} {host}:443;\n" for host in HOSTS)
    # Keep local-only 443 passthrough with original TLS and strict exact SNI.
    return (
        "# STAGING ONLY. Two services, exact hostnames, unknown SNI denied.\n"
        "load_module /usr/lib/nginx/modules/ngx_stream_module.so;\n"
        "worker_processes 1;\n"
        "pid /run/mnebydns-dual/nginx.pid;\n"
        "error_log stderr warn;\n"
        "events { worker_connections 96; }\n"
        "stream {\n"
        "    resolver 9.9.9.9 ipv6=off valid=20s;\n"
        "    resolver_timeout 3s;\n"
        "    map $ssl_preread_server_name $dual_origin {\n"
        "        default 127.0.0.1:1;\n"
        + routes +
        "    }\n"
        "    server {\n"
        f"        listen {SIDECAR};\n"
        "        ssl_preread on;\n"
        "        proxy_pass $dual_origin;\n"
        "        proxy_connect_timeout 5s;\n"
        "        proxy_timeout 90s;\n"
        "        proxy_buffer_size 16k;\n"
        "        access_log off;\n"
        "    }\n"
        "}\n"
    )


def prepare(nginx: pathlib.Path, corefile: pathlib.Path, out: pathlib.Path) -> None:
    if (out.parent != pathlib.Path("/tmp") or
        not re.fullmatch(r"mnebydns-ci-[0-9]+", out.name) or
        out.exists() or out.is_symlink()):
        raise ValueError("Only fresh ephemeral /tmp/mnebydns-ci-<id> allowed")
    for path in (nginx, corefile):
        if not path.is_file() or path.is_symlink():
            raise ValueError("Source snapshot must be a regular file")
    # All validations before writing anything.
    artifacts = (
        ("shared-nginx.staged", render_nginx(nginx.read_text())),
        ("Corefile.staged", render_dns(corefile.read_text(), INGRESS)),
        ("sidecar.nginx.conf", sidecar()),
    )
    out.mkdir(mode=0o700)
    for filename,content in artifacts:
        file=out / filename
        file.write_text(content)
        file.chmod(0o600)
    print("five_exact_host_candidates_staged=yes")
    print("gemini_prior_regression_hosts_excluded=yes")
    print("unproven_googlevideo_media_wildcard_excluded=yes")
    print("no_public_DNS_or_443_or_VPN_mutation=yes")


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("nginx")
    parser.add_argument("corefile")
    parser.add_argument("output_directory")
    args=parser.parse_args()
    prepare(pathlib.Path(args.nginx),pathlib.Path(args.corefile),
            pathlib.Path(args.output_directory))


if __name__ == "__main__":
    main()
