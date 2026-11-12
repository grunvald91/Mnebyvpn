#!/usr/bin/env python3
"""Classify DNS-over-TLS A/AAAA answers without printing IP addresses."""
import secrets
import socket
import ssl
import struct

DE = "89.125.90.101"
RU = "188.120.254.223"
HOST = "dns.mnebyvpn.site"
DOMAINS = (
    "instagram.com", "www.instagram.com", "i.instagram.com",
    "graph.instagram.com", "iglite-z.instagram.com",
    "youtube.com", "www.youtube.com",
)

def skip_name(data, i):
    for _ in range(128):
        if i >= len(data):
            raise ValueError("bad name")
        b = data[i]
        if b == 0:
            return i + 1
        if b & 0xc0 == 0xc0:
            return i + 2
        if b & 0xc0:
            raise ValueError("bad label")
        i += b + 1
    raise ValueError("name too long")

def lookup(domain, typ):
    qid = secrets.randbelow(65536)
    qname = b"".join(bytes([len(p)]) + p.encode("ascii") for p in domain.split(".")) + b"\0"
    wire = struct.pack("!HHHHHH", qid, 256, 1, 0, 0, 0) + qname + struct.pack("!HH", typ, 1)
    with socket.create_connection((HOST, 853), timeout=5) as raw:
        raw.settimeout(5)
        with ssl.create_default_context().wrap_socket(raw, server_hostname=HOST) as tls:
            tls.sendall(struct.pack("!H", len(wire)) + wire)
            prefix = tls.recv(2)
            if len(prefix) != 2:
                raise ValueError("bad prefix")
            length = struct.unpack("!H", prefix)[0]
            response = b""
            while len(response) < length:
                chunk = tls.recv(length - len(response))
                if not chunk:
                    raise EOFError("short response")
                response += chunk
    if len(response) < 12:
        raise ValueError("short header")
    rid, flags, qcount, acount, _, _ = struct.unpack("!HHHHHH", response[:12])
    if rid != qid or not flags & 0x8000:
        raise ValueError("bad id or response")
    offset = 12
    for _ in range(qcount):
        offset = skip_name(response, offset) + 4
    counts = {"de": 0, "ru": 0, "other": 0, "aaaa": 0}
    for _ in range(acount):
        offset = skip_name(response, offset)
        kind, klass, ttl, size = struct.unpack("!HHIH", response[offset:offset + 10])
        offset += 10
        rdata = response[offset:offset + size]
        offset += size
        if kind == 1 and klass == 1 and size == 4:
            ip = socket.inet_ntoa(rdata)
            counts["de" if ip == DE else "ru" if ip == RU else "other"] += 1
        elif kind == 28 and klass == 1 and size == 16:
            counts["aaaa"] += 1
    return f"rcode{flags & 15}_AtoDE{counts['de']}_AtoRU{counts['ru']}_Aother{counts['other']}_AAAA{counts['aaaa']}"

if __name__ == "__main__":
    for domain in DOMAINS:
        for typ, label in ((1, "A"), (28, "AAAA")):
            try:
                status = lookup(domain, typ)
            except Exception as exc:
                status = type(exc).__name__
            print("dot_" + label + "_" + domain.replace(".", "_") + "=" + status, flush=True)
