#!/usr/bin/env python3
"""Non-invasive strict-TLS diagnostic for a temporary localhost-only SNI lab.

Only origin certificate validation and connection outcome are observed.
Never sends HTTP paths, account cookies, user content, or client identity.
This is a CI-runner network test, NOT proof of Russian / user-device access.
"""
from __future__ import annotations

import concurrent.futures
import importlib.util
import json
import pathlib
import socket
import ssl
import sys
import time
from collections import Counter

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE / "priority-service-sni-lab.py"
SPEC = importlib.util.spec_from_file_location("priority_sni_lab", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
LAB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAB)
LAB_ADDRESS = ("127.0.0.1", 15447)
TIMEOUT = 6

def tls_result(host: str, endpoint: tuple[str, int]) -> str:
    """The hostname is always used for both SNI and CA verification."""
    try:
        with socket.create_connection(endpoint, timeout=TIMEOUT) as connection:
            connection.settimeout(TIMEOUT)
            with ssl.create_default_context().wrap_socket(
                connection, server_hostname=host
            ) as tls:
                return "TLS_VALID_" + tls.version().replace(".", "_")
    except (OSError, ssl.SSLError, TimeoutError) as error:
        # Avoid echoing raw exception strings (possible network metadata).
        return type(error).__name__

def check(record: dict[str, str]) -> dict[str, object]:
    host = record["host"]
    started = time.monotonic()
    baseline = tls_result(host, (host, 443))
    relayed = tls_result(host, LAB_ADDRESS)
    return {
        "service": record["service"],
        "host": host,
        "direct": baseline,
        "via_loopback": relayed,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "network_origin": "github-actions-runner",
    }

def unknown_sni_rejected() -> bool:
    try:
        with socket.create_connection(LAB_ADDRESS, timeout=3) as connection:
            connection.settimeout(3)
            with ssl.create_default_context().wrap_socket(
                connection, server_hostname="unknown.example.test"
            ):
                return False
    except (ssl.SSLError, ConnectionError, TimeoutError, OSError):
        return True

def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: probe-priority-service-sni-lab.py MANIFEST")
    manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    allowed = LAB.validate(manifest)
    records = manifest["hosts"]
    if {r["host"] for r in records} != set(allowed):
        raise AssertionError("Unapproved probe hosts")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        outcomes = list(pool.map(check, records))
    for result in outcomes:
        print("priority_sni_lab=" + json.dumps(result, sort_keys=True), flush=True)
    counts = Counter(
        result["service"]
        for result in outcomes
        if str(result["via_loopback"]).startswith("TLS_VALID_")
    )
    print("verified_origin_tls_google=" + str(counts["Google"]), flush=True)
    print("verified_origin_tls_youtube=" + str(counts["YouTube"]), flush=True)
    print("verified_origin_tls_instagram=" + str(counts["Instagram"]), flush=True)
    if not unknown_sni_rejected():
        raise AssertionError("Unexpected wildcard / open TLS proxy")
    print("unknown_sni_denied=yes", flush=True)
    print("production_unchanged=yes", flush=True)
    print("russian_ingress_and_actual_android_access=UNVERIFIED", flush=True)
    # A completely nonfunctional lab must fail rather than announce success.
    # Individual candidate failures are recorded, not discarded.
    if counts["Google"] < 1 or counts["YouTube"] < 1:
        raise AssertionError("No validated origin TLS for an expected service group")

if __name__ == "__main__":
    main()
