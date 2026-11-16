#!/usr/bin/env python3
"""Stdlib-only real DNS-over-TLS smoke, against LOCAL test listener only.

Checks certificate CA + hostname and a handful of DNS result codes. It cannot
certify mobile compatibility, SNI relay, traffic quotas or production readiness.
"""
from __future__ import annotations
import secrets
import socket
import ssl
import struct
import sys
import time
from pathlib import Path

HOST = "127.0.0.1"
PORT = 1853
SERVER_NAME = "dns.test.invalid"
CAFILE = str(Path(__file__).resolve().parent / "certs" / "dns.test.invalid.crt")
MAX_DNS_MESSAGE = 4096

def recv_exact(stream: ssl.SSLSocket, count: int) -> bytes:
    chunks = []
    while count:
        part = stream.recv(count)
        if not part:
            raise ConnectionError("unexpected TLS EOF")
        chunks.append(part)
        count -= len(part)
    return b"".join(chunks)

def dns_question(name: str, record_type: int) -> tuple[int, bytes]:
    identity = secrets.randbits(16)
    labels = name.rstrip(".").split(".")
    qname = b"".join(bytes([len(part)]) + part.encode("ascii") for part in labels) + b"\x00"
    packet = struct.pack("!HHHHHH", identity, 0x0100, 1, 0, 0, 0)
    return identity, packet + qname + struct.pack("!HH", record_type, 1)

def query(name: str, record_type: int) -> tuple[int, int]:
    identity, packet = dns_question(name, record_type)
    tls = ssl.create_default_context(cafile=CAFILE)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    with socket.create_connection((HOST, PORT), timeout=8) as raw:
        raw.settimeout(8)
        with tls.wrap_socket(raw, server_hostname=SERVER_NAME) as stream:
            stream.sendall(struct.pack("!H", len(packet)) + packet)
            size = struct.unpack("!H", recv_exact(stream, 2))[0]
            if not 12 <= size <= MAX_DNS_MESSAGE:
                raise AssertionError("invalid DNS response length")
            answer = recv_exact(stream, size)
    response_id, flags, questions, records, _ns, _extra = struct.unpack("!HHHHHH", answer[:12])
    if response_id != identity or (flags & 0x8000) == 0 or questions != 1:
        raise AssertionError("malformed/unmatched DNS response")
    return flags & 0xF, records

def reject_mismatched_hostname() -> None:
    tls = ssl.create_default_context(cafile=CAFILE)
    with socket.create_connection((HOST, PORT), timeout=5) as raw:
        try:
            with tls.wrap_socket(raw, server_hostname="incorrect.invalid"):
                pass
        except ssl.SSLCertVerificationError:
            return
    raise AssertionError("TLS accepted an invalid certificate hostname")

def main() -> int:
    if not Path(CAFILE).is_file():
        print("ERROR: local-only test certificate missing", file=sys.stderr)
        return 2
    for attempt in range(15):
        try:
            with socket.create_connection((HOST, PORT), timeout=1):
                break
        except OSError:
            if attempt == 14:
                print("ERROR: DoT loopback listener unavailable", file=sys.stderr)
                return 1
            time.sleep(1)
    checks = [
        ("example.org", 1, 0, "A"),
        ("example.org", 28, 0, "AAAA"),
        ("mnebydns-test.invalid", 1, 3, "NXDOMAIN"),
    ]
    for name, rrtype, expected, label in checks:
        rcode, count = query(name, rrtype)
        if rcode != expected or (expected == 0 and count < 1):
            raise AssertionError(f"{label} response unexpected: rcode={rcode}, answers={count}")
        print(f"dot_{label.lower()}=pass")
    reject_mismatched_hostname()
    print("dot_invalid_hostname_rejected=pass")
    print("dot_verified_tls_to_loopback=pass")
    print("public_android_dns=not_tested")
    print("smart_https_routing=not_implemented")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ssl.SSLError, AssertionError, ConnectionError) as exc:
        print(f"DoT smoke failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
