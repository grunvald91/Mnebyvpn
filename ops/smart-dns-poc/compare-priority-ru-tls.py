#!/usr/bin/env python3
"""Read-only service HTTPS/TLS transport comparison, no requests or credentials.

Run this script on the actual Russian reference machine to obtain a Russian
network observation. GitHub Actions runner execution is *not* a RU measurement.

The relay public 443 has no routes for these candidates yet: a closed/alerted
TLS handshake cannot establish whether the network blocked their SNI.
A *timeout* also does not prove network censorship by itself.
Never treat a generic completed TCP connect as successful app access.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import ipaddress
import json
import pathlib
import socket
import ssl
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "priority_sni_lab", ROOT / "priority-service-sni-lab.py"
)
assert SPEC and SPEC.loader
LAB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAB)

LIVE_CONTROLS = ("gemini.google.com", "discord.com", "gateway.discord.gg")
TIMEOUT = 6


def validate_inputs(manifest: dict, ingress_ip: str) -> tuple[str, ...]:
    names = LAB.validate(manifest)
    ip = ipaddress.ip_address(ingress_ip)
    if ip.version != 4 or not ip.is_global:
        raise ValueError("Ingress must be a public IPv4 address")
    if any(n in names for n in LIVE_CONTROLS):
        raise ValueError("Control duplicated as candidate")
    return names


def tls_connect(host: str, ip: str | None, timeout: float = TIMEOUT) -> dict:
    started = time.monotonic()
    connected = False
    try:
        if ip is not None:
            destination = ip
        else:
            # Make direct and foreign ingress comparable: IPv4/TCP/443 only.
            addrs = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
            if not addrs:
                return {"status": "DNS_EMPTY", "tcp_connected": False, "elapsed_ms": 0}
            destination = addrs[0][4][0]
        with socket.create_connection((destination, 443), timeout=timeout) as sock:
            connected = True
            sock.settimeout(timeout)
            # Verify the authentic service hostname as SNI + X.509 SAN.
            with ssl.create_default_context().wrap_socket(sock, server_hostname=host) as tls:
                return {
                    "status": "ORIGIN_CERT_VALID",
                    "tcp_connected": True,
                    "tls": tls.version(),
                    "elapsed_ms": int((time.monotonic() - started) * 1000),
                }
    except (socket.timeout, TimeoutError):
        status = "TIMEOUT_AFTER_TCP" if connected else "TCP_TIMEOUT"
    except ssl.SSLCertVerificationError:
        status = "ORIGIN_CERT_INVALID"
    except ssl.SSLError:
        status = "TLS_ALERT_OR_EOF"
    except socket.gaierror:
        status = "DNS_ERROR"
    except (ConnectionRefusedError, ConnectionResetError, BrokenPipeError):
        status = "CONNECTION_CLOSED"
    except OSError:
        status = "NETWORK_ERROR"
    return {
        "status": status,
        "tcp_connected": connected,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def compare(record: dict, ingress_ip: str) -> dict:
    host = record["host"]
    return {
        "host": host,
        "service": record["service"],
        "direct_ipv4": tls_connect(host, None),
        "via_foreign_public_443": tls_connect(host, ingress_ip),
        "scope": "TLS_HANDSHAKE_ONLY",
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("manifest")
    p.add_argument("--ingress-ip", required=True)
    p.add_argument("--sample-label", default="unspecified-network")
    args = p.parse_args()
    if not args.sample_label.isascii() or not args.sample_label.replace("-", "").isalnum():
        raise SystemExit("Sample label must be a simple non-identifying token")
    manifest = json.loads(pathlib.Path(args.manifest).read_text(encoding="utf-8"))
    names = validate_inputs(manifest, args.ingress_ip)
    records = [r for r in manifest["hosts"] if r["host"] in names]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        verdicts = list(pool.map(lambda r: compare(r, args.ingress_ip), records))
    for v in verdicts:
        print("tls_comparison=" + json.dumps(v, sort_keys=True), flush=True)

    # These controls have been routed through the foreign public ingress in
    # earlier production checks; do not infer their current health on failure.
    controls = {}
    for host in LIVE_CONTROLS:
        controls[host] = tls_connect(host, args.ingress_ip)
        print("tls_control=" + json.dumps({
            "host": host, "via_foreign_public_443": controls[host],
            "scope": "TLS_HANDSHAKE_ONLY",
        }, sort_keys=True), flush=True)

    from collections import Counter
    categories = Counter(v["via_foreign_public_443"]["status"] for v in verdicts)
    print("sample_label=" + args.sample_label)
    print("exact_hosts_tested=" + str(len(verdicts)))
    print("tls_ingress_status_counts=" + json.dumps(categories, sort_keys=True))
    print("no_dns_nginx_vpn_config_changes=yes")
    print("no_http_requests_or_login_data=yes")
    print("end_user_Android_web_video_voice=UNVERIFIED")
    print("unrouted_service_app_access=UNVERIFIED")
    if any(v["status"] != "ORIGIN_CERT_VALID" for v in controls.values()):
        print("::warning::One or more previously live control TLS handshakes failed")
    # Results are data, not proof that unpromoted candidates can be routed.


if __name__ == "__main__":
    main()
