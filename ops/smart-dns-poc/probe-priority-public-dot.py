#!/usr/bin/env python3
"""Read-only strict-public-CA DoT guard for unpromoted Google/YouTube/Meta names.

Uses the existing external DoT probe and checks that an unapproved route
does not accidentally share the *current* Gemini/Discord ingress A answer.
Does not inspect traffic, accounts, HTTPS payloads, or device identifiers.
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


def check(name: str) -> tuple[int, int, int, int]:
    a_rcode, a_count, answers = DOT.query(name, 1, DOT_IP, DOT_PORT, DOT_HOST, None)
    if a_rcode not in (0, 3):
        raise AssertionError(f"Unexpected DNS response for {name}: rcode={a_rcode}")
    for typ, _ttl, raw in answers:
        if typ == 1 and socket.inet_ntoa(raw) == INGRESS_IP:
            raise AssertionError(f"Unapproved public rewrite on {name}")
    # This checks transport, not "synthetic NODATA" detection:
    # ordinary HTTPS/SVCB/AAAA answers may legitimately be empty.
    codes = []
    for rrtype in (28, 64, 65):
        rcode, count, _rr = DOT.query(
            name, rrtype, DOT_IP, DOT_PORT, DOT_HOST, None
        )
        if rcode not in (0, 3):
            raise AssertionError(f"Unexpected RR type response for {name}: {rrtype}/{rcode}")
        codes.append(rcode)
    return (a_rcode, a_count, *codes)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: probe-priority-public-dot.py MANIFEST")
    manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    allowed = LAB.validate(manifest)
    rows = {r["host"]: r for r in manifest["hosts"]}
    if set(rows) != set(allowed):
        raise AssertionError("Manifest admission mismatch")
    counters: Counter[str] = Counter()
    for hostname in allowed:
        rcode, a_count, _aaaa, _svcb, _https = check(hostname)
        group = rows[hostname]["service"]
        counters[group] += 1
        # No returned IPs are logged, only one hostname and a DNS RCODE.
        print(
            f"public_DoT_unpromoted_host={hostname}"
            f" service={group} a_rcode={rcode}"
            f" answer_count={a_count} proxy_rewrite=no",
            flush=True,
        )
    for service in ("Google", "YouTube", "Instagram"):
        print(f"public_DoT_unpromoted_{service}={counters[service]}", flush=True)
    assert sum(counters.values()) == len(allowed) == 15
    print("public_DoT_valid_CA_and_host_identity=yes")
    print("MNEBYDNS_test_did_not_change_live_routing=yes")
    print("no_Russian_device_or_HTTPS_service_access_conclusion=yes")


if __name__ == "__main__":
    main()
