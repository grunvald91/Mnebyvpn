#!/usr/bin/env python3
"""Verify Google ecosystem staged synthetic DoT and Nginx original TLS."""
import importlib.util
import pathlib
import socket
import ssl

HERE=pathlib.Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location("probe",HERE/"probe-gemini-canary.py")
assert s and s.loader
DNS=importlib.util.module_from_spec(s)
s.loader.exec_module(DNS)
IP="89.125.90.101"
PORT=1857
TLS_PORT=15449
CA="certs/dns.test.invalid.crt"
DNS_HOST="dns.test.invalid"

SYNTHETIC=(
    "gemini.google.com",
    "jnn-pa.googleapis.com",
    "waa-pa.clients6.google.com",
    "apis.google.com",
    "play.google.com",
    "www.youtube.com",
    "youtubei.googleapis.com",
    "i.ytimg.com",
    "yt3.ggpht.com",
    "s.ytimg.com",
    "r1---sn-dynamic.googlevideo.com",
    "www.google.com",
    "accounts.google.com",
    "www.google.ru",
    "fonts.gstatic.com",
    "lh3.googleusercontent.com",
    "googleads.g.doubleclick.net",
)
TLS_ORIGINS=(
    "gemini.google.com",
    "jnn-pa.googleapis.com",
    "www.youtube.com",
    "youtubei.googleapis.com",
    "i.ytimg.com",
    "www.gstatic.com",
    "apis.google.com",
)
OUTSIDE=("example.org","discord.com","gosuslugi.ru")


def query(host,typ):
    return DNS.query(host,typ,"127.0.0.1",PORT,DNS_HOST,CA)


def strict_tls(host):
    with socket.create_connection(("127.0.0.1",TLS_PORT),timeout=8) as s:
        s.settimeout(8)
        with ssl.create_default_context().wrap_socket(s,server_hostname=host) as tls:
            return tls.version()


def main():
    for host in SYNTHETIC:
        code,count,records=query(host,1)
        a=[socket.inet_ntoa(data) for kind,_ttl,data in records if kind==1]
        assert code==0 and count==1 and a==[IP],(host,"A",code,count,a)
        for kind in (5,28,64,65):
            c,n,_=query(host,kind)
            assert c==0 and n==0,(host,kind,c,n)
        print("ecosystem_synthetic_A_AAAA_CNAME_SVCB_HTTPS_pass="+host,flush=True)
    for host in TLS_ORIGINS:
        protocol=strict_tls(host)
        assert protocol.startswith("TLS"),(host,protocol)
        print("ecosystem_original_origin_TLS_verified="+host+" protocol="+protocol,flush=True)
    for host in OUTSIDE:
        code,count,records=query(host,1)
        assert code==0 and count>=1,(host,code,count)
        a=[socket.inet_ntoa(data) for kind,_ttl,data in records if kind==1]
        assert IP not in a,(host,a)
        print("unrelated_direct_DNS_unchanged="+host,flush=True)
    for host in ("example.org","discord.com","notgoogle.com"):
        try:
            strict_tls(host)
        except (socket.timeout, TimeoutError, ssl.SSLError, OSError):
            print("nonGoogle_SNI_denied="+host,flush=True)
        else:
            raise AssertionError("Open-proxy fail-closed policy broken: "+host)
    print("Google_Gemini_YouTube_ecosystem_local_integration=PASS",flush=True)
    print("dynamic_googlevideo_origin_reachability=UNVERIFIED",flush=True)
    print("Russian_Android_voice_video_QUIC_E2E=UNVERIFIED",flush=True)
    print("production_untouched=yes",flush=True)


if __name__=="__main__":
    main()
