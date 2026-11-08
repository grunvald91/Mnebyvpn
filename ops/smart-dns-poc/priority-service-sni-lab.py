#!/usr/bin/env python3
"""Render a *loopback-only* TLS/SNI egress lab for exact Google/YouTube/Instagram hosts.

This never edits production CoreDNS, shared Nginx, VPN or existing sidecars.
Source certificates remain end-to-end: Nginx stream does not terminate TLS.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re

ALLOWED = {
    "Google": frozenset({
        "www.google.com", "accounts.google.com", "aistudio.google.com",
        "www.gstatic.com", "ssl.gstatic.com", "oauth2.googleapis.com",
    }),
    "YouTube": frozenset({
        "www.youtube.com", "youtubei.googleapis.com", "i.ytimg.com",
        "accounts.youtube.com",
    }),
    "Instagram": frozenset({
        "www.instagram.com", "api.instagram.com", "gateway.instagram.com",
        "static.cdninstagram.com", "www.facebook.com",
    }),
}
LISTENER = "127.0.0.1:15447"
HOST_RE = re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
SOURCE_RE = re.compile(r"^https://[a-z0-9.-]+/[a-zA-Z0-9._~/%+#?=&-]+$")


def validate(manifest: dict) -> tuple[str, ...]:
    if type(manifest) is not dict or set(manifest) != {
        "schemaVersion", "mode", "publicDnsRewrite",
        "publicIngressChange", "listener", "hosts",
    }:
        raise ValueError("Unexpected lab manifest structure")
    if type(manifest["schemaVersion"]) is not int or manifest["schemaVersion"] != 1:
        raise ValueError("Unknown schema")
    if (manifest["mode"] != "FOREIGN_LOOPBACK_LAB_ONLY"
            or manifest["publicDnsRewrite"] is not False
            or manifest["publicIngressChange"] is not False
            or manifest["listener"] != LISTENER):
        raise ValueError("Public DNS/443 changes are forbidden in this lab")
    records = manifest["hosts"]
    if not isinstance(records, list) or len(records) != sum(map(len, ALLOWED.values())):
        raise ValueError("Missing, duplicate or unexpected host count")
    names = []
    for record in records:
        if type(record) is not dict or set(record) != {
            "host", "service", "role", "source", "status",
        }:
            raise ValueError("Unexpected host record")
        name, service = record["host"], record["service"]
        if (not isinstance(name, str) or not HOST_RE.fullmatch(name)
                or service not in ALLOWED or name not in ALLOWED[service]):
            raise ValueError("Unapproved exact destination")
        if (not isinstance(record["role"], str)
                or not re.fullmatch(r"[a-z][a-z-]{1,40}", record["role"])):
            raise ValueError("Invalid host role")
        if (record["status"] != "unverified"
                or not isinstance(record["source"], str)
                or not SOURCE_RE.fullmatch(record["source"])):
            raise ValueError("No live admission; provenance required")
        names.append(name)
    if len(set(names)) != len(names):
        raise ValueError("Duplicate exact destination")
    if set(names) != set().union(*ALLOWED.values()):
        raise ValueError("Unreviewed hosts or missing reviewed hosts")
    return tuple(sorted(names))


def render(manifest: dict, pid_path: str) -> str:
    names = validate(manifest)
    if "\n" in pid_path or "\r" in pid_path or ";" in pid_path:
        raise ValueError("Unsafe pid path")
    if not re.fullmatch(r"/tmp/mnebydns-ci-[0-9]+/priority-nginx[.]pid", pid_path):
        raise ValueError("PID path must be isolated to an ephemeral run directory")
    entries = "".join(f"        {name} {name}:443;\n" for name in names)
    return (
        "# GENERATED unprivileged loopback-only lab; never deploy as public 443\n"
        "load_module /usr/lib/nginx/modules/ngx_stream_module.so;\n"
        "worker_processes 1;\n"
        f"pid {pid_path};\n"
        "error_log stderr warn;\n"
        "events { worker_connections 80; }\n"
        "stream {\n"
        "    resolver 9.9.9.9 ipv6=off valid=30s;\n"
        "    resolver_timeout 3s;\n"
        "    map $ssl_preread_server_name $priority_origin {\n"
        "        default 127.0.0.1:1;\n"
        + entries +
        "    }\n"
        "    server {\n"
        f"        listen {LISTENER};\n"
        "        ssl_preread on;\n"
        "        proxy_pass $priority_origin;\n"
        "        proxy_connect_timeout 5s;\n"
        "        proxy_timeout 35s;\n"
        "        proxy_buffer_size 16k;\n"
        "        access_log off;\n"
        "    }\n"
        "}\n"
    )


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("manifest")
    p.add_argument("output")
    a = p.parse_args()
    output = pathlib.Path(a.output)
    directory = output.parent
    if (output.name != "priority-nginx.conf"
            or directory.parent != pathlib.Path("/tmp")
            or not re.fullmatch(r"mnebydns-ci-[0-9]+", directory.name)
            or not directory.is_dir() or directory.is_symlink()
            or directory.resolve() != directory
            or output.exists() or output.is_symlink()):
        raise SystemExit("Refusing unsafe/overwritten output path")
    manifest = json.loads(pathlib.Path(a.manifest).read_text(encoding="utf-8"))
    data = render(manifest, str(directory / "priority-nginx.pid"))
    with output.open("x", encoding="utf-8") as f:
        f.write(data)
    output.chmod(0o600)
    print("priority_service_lab_exact_hosts=" + str(len(validate(manifest))))
    print("public_dns_and_public_443_unchanged=yes")
    print("tls_termination_and_request_logs=none")
    print("unknown_sni_denied=yes")


if __name__ == "__main__":
    main()
