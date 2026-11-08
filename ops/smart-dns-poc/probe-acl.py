#!/usr/bin/env python3
"""Verify a DoT test listener is NOT an open recursive resolver.

127.0.0.1 is explicitly allowlisted, while 127.0.0.2 must receive REFUSED.
This tests CoreDNS ACL's actual connection-source handling over DoT.
Local-only certificate; no claims about Android public cert or VPN routing.
"""
from __future__ import annotations
import secrets
import socket
import ssl
import struct
from pathlib import Path

CA = str(Path(__file__).resolve().parent / "certs" / "dns.test.invalid.crt")
HOST = "127.0.0.1"
PORT = 1853
SNI = "dns.test.invalid"


def read_exact(sock: ssl.SSLSocket, length: int) -> bytes:
    result = bytearray()
    while len(result) < length:
        part = sock.recv(length - len(result))
        if not part:
            raise AssertionError("TLS closed before complete DNS answer")
        result.extend(part)
    return bytes(result)


def ask_from(ip: str) -> int:
    ident = secrets.randbits(16)
    question = (
        b"\x07example\x03org\x00" + struct.pack("!HH", 1, 1)
    )
    payload = struct.pack("!HHHHHH", ident, 0x0100, 1, 0, 0, 0) + question
    context = ssl.create_default_context(cafile=CA)
    context.check_hostname = True
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(7)
    try:
        sock.bind((ip, 0))
        sock.connect((HOST, PORT))
        with context.wrap_socket(sock, server_hostname=SNI) as tls:
            tls.sendall(struct.pack("!H", len(payload)) + payload)
            answer_len = struct.unpack("!H", read_exact(tls, 2))[0]
            if not 12 <= answer_len <= 4096:
                raise AssertionError("invalid DNS response size")
            answer = read_exact(tls, answer_len)
    finally:
        sock.close()

    response_id, flags, count, _, _, _ = struct.unpack("!HHHHHH", answer[:12])
    if response_id != ident or not flags & 0x8000 or count != 1:
        raise AssertionError("invalid DNS response")
    return flags & 0xF


def main() -> None:
    allowed = ask_from("127.0.0.1")
    denied = ask_from("127.0.0.2")
    if allowed != 0 or denied != 5:
        raise AssertionError(
            f"DNS ACL unexpected: authorized RCODE={allowed}; unauthorized RCODE={denied}"
        )
    print("authorized_source_dns=NOERROR")
    print("unauthorized_source_dns=REFUSED")
    print("dns_resolver_open_to_unauthorized_clients=no")
    print("test_scope=local_loopback_only")


if __name__ == "__main__":
    main()
