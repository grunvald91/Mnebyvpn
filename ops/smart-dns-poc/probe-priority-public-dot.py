#!/usr/bin/env python3
"""Read-only strict-CA DoT guard for unpromoted Google/YouTube/Meta names.

A SERVFAIL is a resolution-health failure, NOT evidence of a rewrite.
Record that condition explicitly, compare standard encrypted upstream
resolvers and do not incorrectly declare a failed DNS query as "direct".
No production mutation or user data is involved.
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import socket
import sys
from collections import Counter

HERE = pathlib.Path(__file__).resolve().parent


def load_script(name: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, HERE / name)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LAB = load_script("priority-service-sni-lab.py", "priority_sni_lab")
DOT = load_script("probe-gemini-canary.py", "public_dot")
INGRESS_IP = "89.125.90.101"
DOT_HOST = "dns.mnebyvpn.site"
DOT_IP = INGRESS_IP
DOT_PORT = 853
Q_TYPES = (1, 28, 64, 65)


def check(name: str) -> dict[int, int]:
    codes = {}
    for rrtype in Q_TYPES:
        rcode, _count, answers = DOT.query(name, rrtype, DOT_IP, DOT_PORT, DOT_HOST, None)
        if rcode not in (0, 2, 3):
            raise AssertionError(f"Unexpected DNS error for {name}: rr={rrtype}, rcode={rcode}")
        for kind, _ttl, data in answers:
            if kind == 1 and socket.inet_ntoa(data) == INGRESS_IP:
                raise AssertionError(f"Unapproved public A rewrite on {name}")
        codes[rrtype] = rcode
    return codes


def compare_upstream(name: str) -> None:
    """Report only, never change CoreDNS upstream or silently switch resolver."""
    for label, ip, cert_name in (
        ("quad9", "9.9.9.9", "dns.quad9.net"),
        ("google", "8.8.8.8", "dns.google"),
        ("cloudflare", "1.1.1.1", "cloudflare-dns.com"),
    ):
        try:
            rcode, count, _answers = DOT.query(name, 1, ip, 853, cert_name, None)
            print(f"upstream_comparison={name} resolver={label} rcode={rcode} answers={count}", flush=True)
        except (OSError, AssertionError) as error:
            print(f"upstream_comparison={name} resolver={label} exception={type(error).__name__}", flush=True)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: probe-priority-public-dot.py MANIFEST")
    manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    allowed = LAB.validate(manifest)
    rows = {r["host"]: r for r in manifest["hosts"]}
    if set(rows) != set(allowed):
        raise AssertionError("Manifest admission mismatch")

    counters: Counter[str] = Counter()
    inconclusive = []
    for hostname in allowed:
        codes = check(hostname)
        group = rows[hostname]["service"]
        counters[group] += 1
        problems = [qtype for qtype, rcode in codes.items() if rcode == 2]
        result = "INCONCLUSIVE_SERVFAIL" if problems else "NO_UNAPPROVED_A_REWRITE"
        if problems:
            inconclusive.append(hostname)
        print(
            f"public_DoT_host={hostname} service={group}"
            f" A_rcode={codes[1]} result={result}"
            f" servfail_types={','.join(map(str,problems)) or 'none'}",
            flush=True,
        )
    for service in ("Google", "YouTube", "Instagram"):
        print(f"public_DoT_checked_{service}={counters[service]}", flush=True)
    assert sum(counters.values()) == len(allowed) == 15

    for host in inconclusive:
        compare_upstream(host)
    print("strict_public_CA_and_DoT_hostname_validation=yes", flush=True)
    print("unpromoted_hosts_inconclusive=" + str(len(inconclusive)), flush=True)
    print("live_routing_modified=no", flush=True)
    print("russian_device_and_HTTPS_app_operation=UNVERIFIED", flush=True)
    if inconclusive:
        print(
            "::warning::DNS upstream SERVFAIL on "
            + ", ".join(inconclusive)
            + " (not proof of routing); investigate without proxy promotion",
            flush=True,
        )

if __name__ == "__main__":
    main()
