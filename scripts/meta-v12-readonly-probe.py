#!/usr/bin/env python3
"""Read-only public-path probe. No SSH credentials, server changes, or payload capture."""
from __future__ import annotations
import datetime
import secrets
import socket
import ssl
import struct

RU = "188.120.254.223"
DE = "89.125.90.101"
DOT_HOST = "dns.mnebyvpn.site"
TIMEOUT = 5

def emit(name: str, value: str) -> None:
    print(f"{name}={value}", flush=True)

def safe_error(exc: Exception) -> str:
    return type(exc).__name__

def connect(host: str, port: int) -> str:
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT):
            return "tcp_ok"
    except Exception as exc:
        return safe_error(exc)

def tls(host: str, port: int, sni: str) -> str:
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT) as raw:
            raw.settimeout(TIMEOUT)
            with ssl.create_default_context().wrap_socket(raw, server_hostname=sni) as sock:
                return "verified_" + str(sock.version()).replace(".", "_")
    except Exception as exc:
        return safe_error(exc)

def recvn(sock: ssl.SSLSocket, count: int) -> bytes:
    result = bytearray()
    while len(result) < count:
        part = sock.recv(count - len(result))
        if not part:
            raise EOFError("short DNS over TLS response")
        result.extend(part)
    return bytes(result)

def dot_lookup(domain: str, rrtype: int = 1) -> str:
    qname = b"".join(bytes([len(part)]) + part.encode("ascii") for part in domain.split(".")) + b"\0"
    qid = secrets.randbelow(65536)
    question = qname + struct.pack("!HH", rrtype, 1)
    wire = struct.pack("!HHHHHH", qid, 0x0100, 1, 0, 0, 0) + question
    try:
        with socket.create_connection((DOT_HOST, 853), timeout=TIMEOUT) as raw:
            raw.settimeout(TIMEOUT)
            with ssl.create_default_context().wrap_socket(raw, server_hostname=DOT_HOST) as sock:
                sock.sendall(struct.pack("!H", len(wire)) + wire)
                size = struct.unpack("!H", recvn(sock, 2))[0]
                reply = recvn(sock, size)
                if len(reply) < 12:
                    return "malformed"
                rid, flags, count, answers, _, _ = struct.unpack("!HHHHHH", reply[:12])
                if rid != qid or count != 1 or not (flags & 0x8000):
                    return "invalid_response"
                rcode = flags & 15
                names = {0: "NOERROR", 2: "SERVFAIL", 3: "NXDOMAIN", 5: "REFUSED"}
                return f"{names.get(rcode, 'RCODE'+str(rcode))}_answers{answers}"
    except Exception as exc:
        return safe_error(exc)

def main() -> None:
    emit("probe_timestamp_utc", datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    emit("probe_location", "GitHub-hosted-runner-not-RU-client")
    for name, host, port in (
        ("ru_tcp443", RU, 443),
        ("de_tcp443", DE, 443),
        ("de_tcp2053", DE, 2053),
        ("de_tcp8443", DE, 8443),
        ("dot_tcp853", DOT_HOST, 853),
    ):
        emit(name, connect(host, port))
    for host in ("instagram.com", "www.instagram.com", "i.instagram.com", "graph.instagram.com", "iglite-z.instagram.com", "youtube.com", "www.youtube.com"):
        emit("dot_A_" + host.replace(".", "_"), dot_lookup(host))
    for host in ("www.instagram.com", "iglite-z.instagram.com"):
        emit("de_tls_" + host.replace(".", "_"), tls(DE, 443, host))
    emit("origin_tls_i_instagram_com", tls("i.instagram.com", 443, "i.instagram.com"))
    emit("diagnostic_complete", "true")

if __name__ == "__main__":
    main()
