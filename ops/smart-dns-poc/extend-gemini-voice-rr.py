#!/usr/bin/env python3
"""Construct a staged two-host Gemini RPC extension from *live* MNEBYDNS files.

Writes only to caller-specified new files; never edits production directly.
Exact additions, no generic Google wildcard, no TLS decryption.
"""
from __future__ import annotations
import pathlib
import re
import sys

FOREIGN_IP="89.125.90.101"
TARGETS=("jnn-pa.googleapis.com","waa-pa.clients6.google.com")
ROOT="gemini.google.com"
MAP_PATTERN=re.compile(r'(map\s+\$ssl_preread_server_name\s+\$direct_mtproxy_backend\s*\{)([^{}]*)(\})',re.S)

def extend_nginx(source:str)->str:
    maps=list(MAP_PATTERN.finditer(source))
    if len(maps)!=1:raise ValueError("Expected exactly one shared SNI map")
    mat=maps[0]
    body=mat.group(2)
    baseline="gemini.google.com 127.0.0.1:15443;"
    if body.count(baseline)!=1: raise ValueError("Live Gemini route missing or duplicated")
    if "default " not in body:raise ValueError("Missing default route")
    if any(host in source for host in TARGETS):raise ValueError("Target hostname already in Nginx")
    lines="\n"+"".join(f"        {host} 127.0.0.1:15444;\n" for host in TARGETS)
    result=source[:mat.start(2)]+lines+source[mat.start(2):]
    if result.replace(lines,"",1)!=source:raise AssertionError("Nginx entries not additive")
    return result

def render_template(host:str,typ:str)->str:
    exact="^"+re.escape(host).replace(r"\.","[.]")+"[.]$"
    if typ=="A":
        answer=f'        answer "{{{{ .Name }}}} 20 IN A {FOREIGN_IP}"\n'
        response=""
    else:
        answer=""
        response="        rcode NOERROR\n"
    return (f"    template IN {typ} {host} {{\n"
            f"        match {exact}\n"
            f"{answer}{response}"
            "        fallthrough\n"
            "    }\n")

def extend_dns(source:str)->str:
    if source.count("template IN A gemini.google.com {")!=1:
        raise ValueError("Live Gemini synthetic DNS is absent or duplicated")
    if source.count("    cache 30\n")!=1:raise ValueError("Unexpected DNS pipeline")
    if any(host in source for host in TARGETS):raise ValueError("Target hostname already in CoreDNS")
    extra="\n    # MNEBYDNS Gemini two-host RPC pilot (exact targets only)\n"
    for host in TARGETS:
        for typ in ("A","AAAA","HTTPS","SVCB"):
            extra+=render_template(host,typ)
    result=source.replace("    cache 30\n",extra+"    cache 30\n",1)
    if result.replace(extra,"",1)!=source:raise AssertionError("CoreDNS was not additive")
    return result

def main()->None:
    if len(sys.argv)!=5:raise SystemExit("usage: extend-voice-rr.py INPUT_NGINX INPUT_DNS NEW_NGINX NEW_DNS")
    src_nginx,src_dns,out_nginx,out_dns=map(pathlib.Path,sys.argv[1:])
    if not src_nginx.is_file() or not src_dns.is_file():raise SystemExit("Missing source config")
    if out_nginx.exists() or out_dns.exists():raise SystemExit("Refuse to overwrite staged configs")
    nginx=extend_nginx(src_nginx.read_text())
    core=extend_dns(src_dns.read_text())
    out_nginx.write_text(nginx)
    out_dns.write_text(core)
    out_nginx.chmod(src_nginx.stat().st_mode & 0o777)
    out_dns.chmod(src_dns.stat().st_mode & 0o777)
    print("gemini_aux_exact_hosts_staged="+",".join(TARGETS))
    print("original_gemini_and_other_routes_preserved=yes")
if __name__=="__main__": main()
