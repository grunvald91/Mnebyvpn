#!/usr/bin/env python3
"""Real DoT response probe for Gemini auxiliary exact-host pilot."""
from __future__ import annotations
import argparse
import importlib.util
import pathlib
import socket

p=pathlib.Path(__file__).with_name("probe-gemini-canary.py")
spec=importlib.util.spec_from_file_location("gemini_probe",p)
assert spec and spec.loader
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

TARGETS=("jnn-pa.googleapis.com","waa-pa.clients6.google.com")
IP="89.125.90.101"

def main()->None:
    arg=argparse.ArgumentParser()
    arg.add_argument("--ip",default="127.0.0.1")
    arg.add_argument("--port",type=int,default=1853)
    arg.add_argument("--hostname",default="dns.test.invalid")
    arg.add_argument("--cafile")
    a=arg.parse_args()
    for host in TARGETS:
        rcode,count,rec=mod.query(host,1,a.ip,a.port,a.hostname,a.cafile)
        assert rcode==0 and count==1,(host,'A',rcode,count)
        assert rec[0][0]==1 and socket.inet_ntoa(rec[0][2])==IP,(host,'IP')
        assert 0 <= rec[0][1] <= 20
        for rrt in (28,64,65):
            rcode,count,rec=mod.query(host,rrt,a.ip,a.port,a.hostname,a.cafile)
            assert rcode==0 and count==0,(host,rrt,rcode,count)
        print("gemini_aux_dns_host="+host+" four_RRtypes=pass")
    rcode,count,rec=mod.query("gemini.google.com",1,a.ip,a.port,a.hostname,a.cafile)
    assert rcode==0 and count>=1 and any(kind==1 and socket.inet_ntoa(data)==IP for kind,ttl,data in rec)
    print("existing_gemini_host=preserved")
    for host in ("www.google.com","aistudio.google.com","example.org"):
        rcode,count,rec=mod.query(host,1,a.ip,a.port,a.hostname,a.cafile)
        assert rcode==0 and count>=1,(host,rcode,count)
        assert all(socket.inet_ntoa(data)!=IP for kind,ttl,data in rec if kind==1)
        print("non_target_"+host+"=normal_upstream")
    print("gemini_aux_public_DoT_routing=pass")
if __name__=="__main__":main()
