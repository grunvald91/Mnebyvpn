#!/usr/bin/env python3
"""External DNS-over-TLS validation for one authorized ephemeral client.

Public CA and exact hostname are required; no insecure SSL fallback. Does
not test a site's HTTPS egress or mark Smart DNS routing as implemented.
"""
from __future__ import annotations
import argparse
import secrets
import socket
import ssl
import struct


def recv_exact(connection: ssl.SSLSocket, n: int) -> bytes:
    result = bytearray()
    while len(result) < n:
        part = connection.recv(n - len(result))
        if not part:
            raise ConnectionError("TLS stream ended while reading DNS")
        result.extend(part)
    return bytes(result)


def dns_answer(host: str, dest_ip: str, qtype: int, qname: str) -> tuple[int, int]:
    identity = secrets.randbits(16)
    qwire = b"".join(bytes((len(p),)) + p.encode("ascii") for p in qname.split(".")) + b"\x00"
    request = struct.pack("!HHHHHH", identity, 0x0100, 1, 0, 0, 0) + qwire + struct.pack("!HH", qtype, 1)
    tlsctx = ssl.create_default_context()
    tlsctx.minimum_version = ssl.TLSVersion.TLSv1_2
    with socket.create_connection((dest_ip, 853), timeout=6) as sock:
        sock.settimeout(6)
        with tlsctx.wrap_socket(sock, server_hostname=host) as tls:
            tls.sendall(struct.pack("!H", len(request)) + request)
            response_length, = struct.unpack("!H", recv_exact(tls, 2))
            if response_length < 12 or response_length > 4096:
                raise AssertionError("Unexpected DNS response length")
            answer = recv_exact(tls, response_length)
    message_id, flags, question_count, answers, _, _ = struct.unpack("!HHHHHH", answer[:12])
    if message_id != identity or not flags & 0x8000 or question_count != 1:
        raise AssertionError("Invalid DNS packet returned")
    return flags & 15, answers


def wrong_hostname_is_rejected(dest_ip: str) -> None:
    ctx = ssl.create_default_context()
    with socket.create_connection((dest_ip, 853), timeout=6) as sock:
        sock.settimeout(6)
        try:
            with ctx.wrap_socket(sock, server_hostname="not-the-dot-host.invalid"):
                pass
        except ssl.SSLCertVerificationError:
            print("untrusted_tls_hostname=rejected")
            return
    raise AssertionError("TLS hostname verification erroneously accepted wrong domain")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hostname", required=True)
    parser.add_argument("--server-ip", required=True)
    args = parser.parse_args()
    for name, qtype, expected_code, expected_answers in [
        ("example.org", 1, 0, 1),
        ("example.org", 28, 0, 1),
        ("mnebydns-nonexistent-test.invalid", 1, 3, 0),
    ]:
        rcode, answers = dns_answer(args.hostname, args.server_ip, qtype, name)
        if rcode != expected_code or answers < expected_answers:
            raise AssertionError(f"Unacceptable DoT DNS response type={qtype} code={rcode} answers={answers}")
        print(f"dns_type_{qtype}_rcode_{rcode}=pass")
    wrong_hostname_is_rejected(args.server_ip)
    print("public_dot_tls_identity=verified")
    print("public_dot_dns_resolver=verified")
    print("smart_domain_routing=not_implemented")


if __name__ == "__main__":
    main()
