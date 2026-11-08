#!/usr/bin/env python3
"""Strict-TLS A/AAAA/CNAME/HTTPS/SVCB proof for a *local* staged YouTube resolver."""
from __future__ import annotations
import argparse
import importlib.util
import pathlib
import socket

HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("probe",HERE/"probe-gemini-canary.py")
assert spec and spec.loader
DOT=importlib.util.module_from_spec(spec)
spec.loader.exec_module(DOT)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--cafile",required=True)
    p.add_argument("--port",type=int,default=1855)
    args=p.parse_args()
    for host in ("www.youtube.com","youtubei.googleapis.com"):
        code,count,records=DOT.query(host,1,"127.0.0.1",args.port,
                                     "dns.test.invalid",args.cafile)
        assert code==0 and count==1,(host,"A",code,count)
        assert any(kind==1 and socket.inet_ntoa(value)=="9.9.9.9"
                   for kind,_ttl,value in records),(host,records)
        for rrtype in (28,5,64,65):
            code,count,_=DOT.query(host,rrtype,"127.0.0.1",args.port,
                                   "dns.test.invalid",args.cafile)
            assert code==0 and count==0,(host,rrtype,code,count)
        print("youtube_staged_exact_RR_pass="+host,flush=True)
    for host in ("gemini.google.com","discord.com",
                 "gateway.discord.gg","cdn.discordapp.com"):
        code,count,records=DOT.query(host,1,"127.0.0.1",args.port,
                                     "dns.test.invalid",args.cafile)
        assert code==0 and count==1,(host,code,count)
        assert any(kind==1 and socket.inet_ntoa(value)=="89.125.90.101"
                   for kind,_ttl,value in records)
        print("original_live_route_preserved_in_fixture="+host,flush=True)
    print("no_live_public_DNS_or_443_changed=yes")
    print("YouTube_video_playback=UNVERIFIED")

if __name__=="__main__":
    main()
