#!/usr/bin/env python3
"""Live TLS probe of Gemini DNS canary. Defaults to local test port 1853."""
from __future__ import annotations
import argparse
import secrets
import socket
import ssl
import struct

def exactly(s: ssl.SSLSocket, n: int) -> bytes:
    data=bytearray()
    while len(data)<n:
        chunk=s.recv(n-len(data))
        if not chunk:raise AssertionError('truncated DoT message')
        data.extend(chunk)
    return bytes(data)

def query(name: str, rrtype: int, addr: str, port: int, server_name: str,
          cafile: str | None) -> tuple[int, int, list[bytes]]:
    token=secrets.randbits(16)
    name_wire=b''.join(bytes([len(x)]) + x.encode('ascii') for x in name.rstrip('.').split('.'))+b'\0'
    message=struct.pack('!HHHHHH',token,0x0100,1,0,0,0)+name_wire+struct.pack('!HH',rrtype,1)
    ctx=ssl.create_default_context(cafile=cafile)
    with socket.create_connection((addr,port),timeout=8) as tcp:
        tcp.settimeout(8)
        with ctx.wrap_socket(tcp,server_hostname=server_name) as tls:
            tls.sendall(struct.pack('!H',len(message))+message)
            total=struct.unpack('!H',exactly(tls,2))[0]
            assert 12<=total<=4096
            packet=exactly(tls,total)
    received,flags,questions,answers,_,_=struct.unpack('!HHHHHH',packet[:12])
    assert received==token and flags&0x8000 and questions==1
    # Skip the one original uncompressed question.
    pos=12+len(name_wire)+4
    records=[]
    for _ in range(answers):
        # Answer name may be a DNS compression pointer or explicit labels.
        while True:
            first=packet[pos]
            if first&0xc0==0xc0:
                pos+=2
                break
            if first==0:
                pos+=1
                break
            assert 0<first<64
            pos+=first+1
        kind,clazz,ttl,length=struct.unpack('!HHIH',packet[pos:pos+10])
        pos+=10
        rdata=packet[pos:pos+length]
        pos+=length
        assert clazz==1
        records.append((kind,ttl,rdata))
    return flags&15,answers,records

def main()->None:
    p=argparse.ArgumentParser()
    p.add_argument('--ip',default='127.0.0.1')
    p.add_argument('--port',type=int,default=1853)
    p.add_argument('--hostname',default='dns.test.invalid')
    p.add_argument('--cafile')
    args=p.parse_args()

    rcode,count,records=query('gemini.google.com',1,args.ip,args.port,args.hostname,args.cafile)
    assert rcode==0 and count==1,('A failed',rcode,count)
    assert records[0][0]==1 and socket.inet_ntoa(records[0][2])=='89.125.90.101'
    # Cached DNS replies count TTL down; 0..20 is valid, not a failure.
    assert 0 <= records[0][1] <= 20, ('unexpected TTL',records[0][1])
    print('gemini_A_foreign_ingress=pass')

    for rr in [28,64,65]:
        rcode,count,records=query('gemini.google.com',rr,args.ip,args.port,args.hostname,args.cafile)
        assert rcode==0 and count==0,(rr,rcode,count)
        print('gemini_qtype_'+str(rr)+'_NODATA=pass')

    # Proof we did not rewrite other Google services or a normal domain.
    for name in ['www.google.com','example.org','aistudio.google.com']:
        rcode,count,records=query(name,1,args.ip,args.port,args.hostname,args.cafile)
        assert rcode==0 and count>=1,(name,rcode,count)
        for kind,_ttl,data in records:
            if kind==1:
                assert socket.inet_ntoa(data)!='89.125.90.101',('rewrite leak',name)
        print('non_target_'+name+'=upstream')

    print('canary_dns_rr_compatibility=pass')

if __name__=='__main__':
    main()
