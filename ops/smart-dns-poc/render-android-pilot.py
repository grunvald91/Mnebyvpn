#!/usr/bin/env python3
"""Render a *candidate* public DoT ACL Corefile; deliberately NO deployment.

The template is safe only for a single-client pilot with its source IPv4
allowlisted. Android Private DNS has no portable client token in DoT, and a
hostname alone cannot serve as paid subscription authorization.
"""
from __future__ import annotations

import argparse
import ipaddress
from pathlib import Path

CERT = "/etc/mnebydns/certs/fullchain.pem"
KEY = "/etc/mnebydns/certs/privkey.pem"


def public_ipv4(raw: str, label: str) -> str:
    if "/" in raw:
        raise ValueError(f"{label} must be a single IPv4 address, not a CIDR subnet")
    try:
        address = ipaddress.ip_address(raw)
    except ValueError as exc:
        raise ValueError(f"{label} must be valid IPv4") from exc
    if not isinstance(address, ipaddress.IPv4Address) or not address.is_global:
        raise ValueError(f"{label} must be publicly routable IPv4")
    return str(address)


def render(bind_ipv4: str, client_ipv4: str) -> str:
    bind = public_ipv4(bind_ipv4, "listener IP")
    client = public_ipv4(client_ipv4, "allowed client IP")
    if bind == client:
        raise ValueError("client address must not equal foreign VPS interface IP")
    return f"""# MNEBYDNS DoT single-client pilot ONLY. Not a commercial resolver.
# Do not activate until DNS, trusted certificate, abuse/port and ACL gates pass.
tls://.:853 {{
    bind {bind}
    tls {CERT} {KEY}
    acl {{
        allow net {client}/32
        block
    }}
    cache 30
    forward . tls://9.9.9.9 {{
        tls_servername dns.quad9.net
        health_check 5s
        max_concurrent 64
    }}
}}
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind-ip", required=True, help="verified IPv4 on foreign VPS")
    parser.add_argument("--allow-client-ip", required=True, help="one verified testing device's outbound IPv4")
    parser.add_argument("--output", required=True, help="path to STAGING Corefile; does not activate")
    args = parser.parse_args()
    text = render(args.bind_ip, args.allow_client_ip)
    path = Path(args.output)
    if path.exists():
        raise SystemExit("refusing to overwrite an existing configuration")
    # Never create new system directories or write service configs as a side effect.
    if not path.parent.is_dir():
        raise SystemExit("output parent directory must already exist")
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)
    print("staged_only=true")
    print("public_dns_listener_started=false")
    print("certificate_and_domain_still_required=true")


if __name__ == "__main__":
    main()
