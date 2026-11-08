#!/usr/bin/env python3
"""Stage a second strictly authenticated DoT upstream ONLY after SERVFAIL.

CoreDNS 1.15 forward supports 'next SERVFAIL' into the next forward plugin.
This staging tool DOES NOT install or reload any production service.
"""
from __future__ import annotations

import argparse
import pathlib
import re

OLD = """    forward . tls://9.9.9.9 {
        tls_servername dns.quad9.net
        health_check 5s
        max_concurrent 16
        max_connect_attempts 2
    }
"""
NEW = """    # First preserve the original Quad9 encrypted upstream.
    forward . tls://9.9.9.9 {
        tls_servername dns.quad9.net
        health_check 5s
        max_concurrent 16
        max_connect_attempts 2
        next SERVFAIL
    }
    # Separate TLS identity: CoreDNS requires distinct forward plugin blocks
    # for resolvers with different authenticated certificate hostnames.
    forward . tls://1.1.1.1 {
        tls_servername cloudflare-dns.com
        health_check 5s
        max_concurrent 16
        max_connect_attempts 2
    }
"""


def render(corefile: str) -> str:
    if corefile.count(OLD) != 1:
        raise ValueError("Expected exactly one original authenticated Quad9 block")
    if "template IN A gemini.google.com {" not in corefile:
        raise ValueError("Original Gemini exact DNS rule must be preserved")
    if "tls://1.1.1.1" in corefile or "next SERVFAIL" in corefile:
        raise ValueError("Fallback already present; refusing duplicate configuration")
    if corefile.count("cache 30") != 1:
        raise ValueError("Unexpected cache configuration")
    result = corefile.replace(OLD, NEW, 1)
    if result.replace(NEW, OLD, 1) != corefile:
        raise AssertionError("CoreDNS mutation was not exclusively additive")
    return result


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("source")
    p.add_argument("output")
    a = p.parse_args()
    source = pathlib.Path(a.source)
    output = pathlib.Path(a.output)
    parent = output.parent
    if (not source.is_file() or source.is_symlink()
            or not re.fullmatch(r"mnebydns-ci-[0-9]+", parent.name)
            or parent.parent != pathlib.Path("/tmp")
            or not parent.is_dir() or parent.is_symlink()
            or parent.resolve() != parent
            or output.name != "Corefile.fallback.staged"
            or output.exists() or output.is_symlink()
            or source.resolve() == output.resolve()):
        raise SystemExit("Output must be new and confined to an ephemeral CI directory")
    rendered = render(source.read_text(encoding="utf-8"))
    with output.open("x", encoding="utf-8") as stream:
        stream.write(rendered)
    output.chmod(0o600)
    print("existing_synthetic_dns_routes_preserved=yes")
    print("Quad9_primary_DoT_unchanged=yes")
    print("Cloudflare_DoT_is_SERVFAIL_fallback_only=yes")
    print("production_configuration_untouched=yes")


if __name__ == "__main__":
    main()
