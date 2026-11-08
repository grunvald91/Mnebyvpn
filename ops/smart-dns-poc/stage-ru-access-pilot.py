#!/usr/bin/env python3
"""Stage an allowlisted, exact-domain MNEBYDNS public TLS passthrough pilot.

Never mutates active configuration. Nginx 443 remains the existing dispatcher;
the generated sidecar binds ONLY 127.0.0.1:15446 and denies unknown SNI.
"""
from __future__ import annotations
import argparse
import json
import pathlib
import re
from typing import Any

EXPECTED_HOSTS = frozenset({
    "discord.com", "gateway.discord.gg", "cdn.discordapp.com",
    "www.instagram.com", "www.facebook.com", "static.cdninstagram.com",
})
FOREIGN_IP = "89.125.90.101"
LOCAL_TARGET = "127.0.0.1:15446"
NGINX_MAP = re.compile(r"(map\s+\$ssl_preread_server_name\s+\$direct_mtproxy_backend\s*\{)([^{}]*)(\})", re.S)
DNS_ANCHOR = "    cache 30\n"
HOST_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")

def domains(manifest: dict[str,Any])->tuple[str,...]:
    if not isinstance(manifest,dict) or set(manifest)!={
        "schemaVersion","foreignIngressIPv4","listener","purpose","entries"
    }:raise ValueError("Unexpected route manifest structure")
    if manifest["schemaVersion"] != 1 or manifest["foreignIngressIPv4"] != FOREIGN_IP or manifest["listener"] != LOCAL_TARGET:
        raise ValueError("Unexpected port, server, or manifest schema")
    entries=manifest["entries"]
    if not isinstance(entries,list) or len(entries)!=len(EXPECTED_HOSTS):
        raise ValueError("Unexpected domain count")
    result=[]
    for row in entries:
        if not isinstance(row,dict) or set(row)!={"domain","service","ruProbe","foreignProbe","evidence"}:
            raise ValueError("Invalid domain entry")
        name=row["domain"]
        if not isinstance(name,str) or name.lower()!=name or not HOST_PATTERN.fullmatch(name):
            raise ValueError("Invalid exact hostname")
        if name not in EXPECTED_HOSTS:raise ValueError("Unapproved or wildcard hostname: "+name)
        if row["service"] not in ("discord","meta"):
            raise ValueError("Unexpected service")
        if row["foreignProbe"]!="tls_ok" or row["ruProbe"] not in ("tls_timeout","dns_error"):
            raise ValueError("Missing differential TLS evidence")
        if not isinstance(row["evidence"],str) or not row["evidence"].startswith("https://"):
            raise ValueError("Missing public evidence URL")
        result.append(name)
    if set(result)!=EXPECTED_HOSTS or len(set(result))!=len(result):
        raise ValueError("Duplicate or missing exact host")
    return tuple(sorted(result))

def render_sni(nginx:str,names:tuple[str,...])->str:
    maps=list(NGINX_MAP.finditer(nginx))
    if len(maps)!=1:raise ValueError("Active Nginx SNI table not uniquely identified")
    matched=maps[0]
    body=matched.group(2)
    if body.count("gemini.google.com 127.0.0.1:15443;")!=1 or "default " not in body:
        raise ValueError("Original Gemini/legacy Nginx routes missing")
    if any(re.search(r"\b"+re.escape(name)+r"\b",nginx) for name in names):
        raise ValueError("Some pilot domain already present in Nginx configuration")
    addition="\n" + "".join("        "+host+" "+LOCAL_TARGET+";\n" for host in names)
    result=nginx[:matched.start(2)]+addition+nginx[matched.start(2):]
    if result.replace(addition,"",1)!=nginx:raise AssertionError("Non-additive SNI mutation")
    return result

def dns_template(host:str,qtype:str)->str:
    exact="^"+re.escape(host).replace(r"\.","[.]")+"[.]$"
    ans=(f'        answer "{{{{ .Name }}}} 20 IN A {FOREIGN_IP}"\n'
         if qtype=="A" else "        rcode NOERROR\n")
    return (f"    template IN {qtype} {host} {{\n"
            f"        match {exact}\n{ans}"
            "        fallthrough\n    }\n")

def render_dns(core:str,names:tuple[str,...])->str:
    if core.count("template IN A gemini.google.com {")!=1 or core.count(DNS_ANCHOR)!=1:
        raise ValueError("Existing original Gemini DNS policy missing")
    if any(name in core for name in names):
        raise ValueError("Pilot domain already present in live CoreDNS")
    extra="\n    # MNEBYDNS verified initial RU access pilot (6 exact names)\n"
    for host in names:
        for kind in ("A","AAAA","HTTPS","SVCB"):
            extra+=dns_template(host,kind)
    result=core.replace(DNS_ANCHOR,extra+DNS_ANCHOR,1)
    if result.replace(extra,"",1)!=core:raise AssertionError("Non-additive DNS mutation")
    return result

def render_relay(names:tuple[str,...])->str:
    table="".join(f"        {name} {name}:443;\n" for name in names)
    return (
        "# MNEBYDNS six exact-host RU access TLS passthrough; no public listener.\n"
        "load_module /usr/lib/nginx/modules/ngx_stream_module.so;\n"
        "worker_processes 1;\n"
        "pid /run/mnebydns-ru-access/nginx.pid;\n"
        "error_log stderr warn;\n"
        "events { worker_connections 96; }\n"
        "stream {\n"
        "    resolver 9.9.9.9 ipv6=off valid=30s;\n"
        "    resolver_timeout 3s;\n"
        "    map $ssl_preread_server_name $ru_access_target {\n"
        "        default 127.0.0.1:1;\n"
        +table+
        "    }\n"
        "    server {\n"
        "        listen 127.0.0.1:15446;\n"
        "        ssl_preread on;\n"
        "        proxy_pass $ru_access_target;\n"
        "        proxy_connect_timeout 5s;\n"
        "        proxy_timeout 90s;\n"
        "        proxy_buffer_size 16k;\n"
        "        access_log off;\n"
        "    }\n"
        "}\n"
    )

def main()->None:
    parser=argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("live_nginx")
    parser.add_argument("live_dns")
    parser.add_argument("output_directory")
    args=parser.parse_args()
    names=domains(json.loads(pathlib.Path(args.manifest).read_text()))
    source_nginx=pathlib.Path(args.live_nginx)
    source_dns=pathlib.Path(args.live_dns)
    if not source_nginx.is_file() or not source_dns.is_file():
        raise SystemExit("Missing original live config")
    out=pathlib.Path(args.output_directory)
    out.mkdir(mode=0o700,parents=False,exist_ok=False)
    for name,content,mode in [
        ("nginx.pilot",render_sni(source_nginx.read_text(),names),source_nginx.stat().st_mode&0o777),
        ("dns.pilot",render_dns(source_dns.read_text(),names),source_dns.stat().st_mode&0o777),
        ("relay.conf",render_relay(names),0o644)
    ]:
        target=out/name
        with target.open("x",encoding="utf-8") as stream:
            stream.write(content)
        target.chmod(mode)
    print("exact_host_policy_staged="+str(len(names)))
    print("live_configuration_untouched=yes")
    print("all_unknown_sni_denied=yes")
if __name__=="__main__":main()
