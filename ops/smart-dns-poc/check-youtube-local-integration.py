#!/usr/bin/env python3
"""Prepare or verify an entirely localhost-only two-host YouTube DoT + TLS trial.

Creates no public port, performs no HTTP requests, and cannot amend production.
Stages the existing Gemini + Discord routes before two exact YouTube entries.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import socket
import ssl

HERE = pathlib.Path(__file__).resolve().parent
DNS_PORT = 1855
SNI_PORT = 15448
CAFILE = "certs/dns.test.invalid.crt"


def load(filename: str, name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


YT = load("stage-youtube-exact-canary.py", "youtube_stage")
DISCORD = load("stage-ru-access-pilot.py", "discord_stage")
FOREIGN_INGRESS = DISCORD.FOREIGN_IP
DOT = load("probe-gemini-canary.py", "youtube_dot_probe")


def prepare(directory: pathlib.Path) -> None:
    if directory.parent != pathlib.Path("/tmp") or not directory.name.startswith("mnebydns-ci-"):
        raise ValueError("Refuse a non-ephemeral output directory")
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError("Ephemeral directory must exist as an ordinary directory")
    names = DISCORD.domains(json.loads((HERE / "ru-access-first-pilot.json").read_text()))
    baseline = DISCORD.render_dns((HERE / "Corefile.gemini-canary").read_text(), names)
    staged = YT.staged_dns(baseline, FOREIGN_INGRESS)
    replacements = (
        ("tls://.:853", "tls://.:1855"),
        ("bind 89.125.90.101", "bind 127.0.0.1"),
        ("/run/credentials/mnebydns-dot.service/fullchain.pem", CAFILE),
        ("/run/credentials/mnebydns-dot.service/privkey.pem", "certs/dns.test.invalid.key"),
    )
    for old, new in replacements:
        if staged.count(old) != 1:
            raise ValueError("Unexpected CoreDNS source format: " + old)
        staged = staged.replace(old, new, 1)
    if staged.count("tls://.:1855") != 1 or staged.count("bind 127.0.0.1") != 1:
        raise AssertionError("Local-only CoreDNS binding lost")
    dns_path = HERE / "Corefile.youtube-local"
    if dns_path.exists() or dns_path.is_symlink():
        raise ValueError("Refusing to replace any existing local test config")
    with dns_path.open("x", encoding="utf-8") as out:
        out.write(staged)
    dns_path.chmod(0o644)

    sidecar = YT.sidecar()
    old = "pid /run/mnebydns-youtube/nginx.pid;"
    if sidecar.count(old) != 1:
        raise ValueError("Unexpected Nginx pid target")
    sidecar = sidecar.replace(old, "pid " + str(directory / "nginx.pid") + ";")
    with (directory / "youtube-nginx.conf").open("x", encoding="utf-8") as out:
        out.write(sidecar)
    (directory / "youtube-nginx.conf").chmod(0o600)
    print("youtube_2host_DNS_and_TLS_staged_locally=yes")
    print("ports_only_localhost=yes")
    print("production_unchanged=yes")


def assert_dns(name: str, target: str) -> None:
    code, count, records = DOT.query(name, 1, "127.0.0.1", DNS_PORT,
                                     "dns.test.invalid", CAFILE)
    addrs = [socket.inet_ntoa(raw) for typ, _ttl, raw in records if typ == 1]
    if code != 0 or count != 1 or addrs != [target]:
        raise AssertionError("Unexpected exact A record for " + name)
    for kind in (5, 28, 64, 65):
        code, count, _ = DOT.query(name, kind, "127.0.0.1", DNS_PORT,
                                   "dns.test.invalid", CAFILE)
        if code != 0 or count != 0:
            raise AssertionError("Unexpected DNS answer for " + name + "/" + str(kind))


def strict_local_tls(host: str) -> str:
    with socket.create_connection(("127.0.0.1", SNI_PORT), timeout=6) as raw:
        raw.settimeout(6)
        with ssl.create_default_context().wrap_socket(raw, server_hostname=host) as tls:
            return tls.version() or "UNKNOWN"


def verify() -> None:
    for host in YT.HOSTS:
        assert_dns(host, FOREIGN_INGRESS)
        print("youtube_DoT_exact_A_AAAA_CNAME_SVCB_HTTPS=pass host=" + host, flush=True)
        version = strict_local_tls(host)
        if not version.startswith("TLS"):
            raise AssertionError("YouTube origin TLS not verified for " + host)
        print("youtube_SNI_origin_certificate=pass host=" + host + " tls=" + version, flush=True)
    for host in YT.EXISTING:
        # Discord stage makes all existing domains exact-template compatible.
        assert_dns(host, FOREIGN_INGRESS)
        print("existing_Gemini_or_Discord_DoT_unchanged=" + host, flush=True)
    try:
        strict_local_tls("not-in-pilot.example.test")
    except (OSError, ssl.SSLError, TimeoutError):
        print("unknown_SNI_denied=yes", flush=True)
    else:
        raise AssertionError("Proxy allowed unknown SNI")
    print("youtube_2host_local_runtime_integration=PASS", flush=True)
    print("Russian_user_video_playback=UNVERIFIED", flush=True)
    print("IPv6_QUIC_and_media_CDN=NOT_INCLUDED", flush=True)
    print("production_unchanged=yes", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "verify"))
    parser.add_argument("--workdir")
    args = parser.parse_args()
    if args.action == "prepare":
        if not args.workdir:
            raise SystemExit("--workdir required for prepare")
        prepare(pathlib.Path(args.workdir))
    else:
        verify()


if __name__ == "__main__":
    main()
