#!/usr/bin/env python3
"""Strict CA DoT responses for six exact multiservice domains; no login claims."""
from __future__ import annotations
import argparse, importlib.util, pathlib, socket, json
p=pathlib.Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('dnsprobe',p/'probe-gemini-canary.py')
assert s and s.loader
probe=importlib.util.module_from_spec(s)
s.loader.exec_module(probe)
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--ip',default='127.0.0.1')
    parser.add_argument('--port',type=int,default=1853)
    parser.add_argument('--hostname',default='dns.test.invalid')
    parser.add_argument('--cafile')
    args=parser.parse_args()
    m=json.loads((p/'ru-access-first-pilot.json').read_text())
    hosts=tuple(sorted(x['domain'] for x in m['entries']))
    for name in hosts:
        rcode,count,answers=probe.query(name,1,args.ip,args.port,args.hostname,args.cafile)
        assert rcode==0 and count==1,(name,rcode,count)
        assert answers[0][0]==1 and socket.inet_ntoa(answers[0][2])=='89.125.90.101'
        assert 0<=answers[0][1]<=20
        for qtype in (28,64,65):
            rcode,count,_=probe.query(name,qtype,args.ip,args.port,args.hostname,args.cafile)
            assert rcode==0 and count==0,(name,qtype,rcode,count)
        print('verified_exact_domain='+name+' A_AAAA_HTTPS_SVCB=pass')
    rcode,count,answers=probe.query('gemini.google.com',1,args.ip,args.port,args.hostname,args.cafile)
    assert rcode==0 and any(kind==1 and socket.inet_ntoa(raw)=='89.125.90.101'
                                  for kind,ttl,raw in answers)
    print('original_gemini_route=preserved')
    for name in ['www.google.com','www.youtube.com','example.org','gosuslugi.ru']:
        rcode,count,answers=probe.query(name,1,args.ip,args.port,args.hostname,args.cafile)
        assert rcode==0 and count>=1,(name,rcode,count)
        assert all(socket.inet_ntoa(raw)!='89.125.90.101'
                   for kind,ttl,raw in answers if kind==1)
        print('unlisted_domain='+name+' unmodified=pass')
    print('multiservice_dns_external_verified=yes')
if __name__=='__main__':main()
