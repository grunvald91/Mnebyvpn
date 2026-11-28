"""Disposable trial TLS/Ed25519/SQL quota test; never uses production."""
import asyncio
import base64
import json
import ssl
import struct
import sys
import time
from pathlib import Path
from unittest.mock import patch
from fi_dns_meter_loopback import LoopbackMeterTransport
from fi_dns_meter_rpc import SignedQueryMeter
from fi_enrollment_ssh import openssl_sign, openssl_verify
from fi_dns_signed_grants import validate, meter_policy, hostname_digest, message
from fi_dns_customer_policy import CustomerAuthorizer, chargeable_questions
import fi_dns_tls_session as session

async def main():
    root=Path(sys.argv[1])
    cfg=json.loads((root/"fixture.json").read_text())
    snap=json.loads((root/"snapshot.json").read_text())
    validate(snap,time.time())
    openssl_verify(root/"controller.pub",base64.urlsafe_b64decode(snap["signature"]+"=="),message(snap))
    assert len(snap["grants"])==1
    assert snap["grants"][0]["state"]=="ACTIVE_TRIAL"
    assert snap["grants"][0]["tokenSha256"]==hostname_digest(cfg["hostname"])
    class VerifiedFixture:
        async def meter_policy(self,hostname):
            return meter_policy(snap,hostname)
    class Resolver:
        def __init__(self): self.calls=0
        async def resolve(self,query):
            self.calls+=1
            return query[:2]+bytes.fromhex("81800001000100000000")+query[12:]+bytes.fromhex("c00c000100010000003c0004c0000201")
    meter=SignedQueryMeter(LoopbackMeterTransport(cfg["port"]),
        lambda msg:openssl_sign(root/"node.key",msg),
        lambda msg,sig:openssl_verify(root/"controller.pub",sig,msg))
    resolver=Resolver()
    auth=CustomerAuthorizer(VerifiedFixture())
    # example.com is ordinary/direct; both identical requests must be charged.
    query=bytes.fromhex("123401000001000000000000076578616d706c6503636f6d0000010001")
    policy=chargeable_questions({"exact":["www.youtube.com"],"families":[]})
    assert not policy(query)
    with patch.object(session,"REGIONAL_CERT_DIR",root),patch.object(session,"verify_pair"):
        server=await session.make_metered_loopback_server(
            authorizer=auth,meter=meter,resolver=resolver,listen_port=0,
            chargeable=policy,meter_policy=auth.meter_policy)
    ctx=ssl.create_default_context(cafile=str(root/"fullchain.pem"))
    async def ask(host):
        reader,writer=await asyncio.open_connection("127.0.0.1",server.sockets[0].getsockname()[1],ssl=ctx,server_hostname=host)
        try:
            writer.write(struct.pack("!H",len(query))+query)
            await writer.drain()
            try:
                size=struct.unpack("!H",await asyncio.wait_for(reader.readexactly(2),10))[0]
                return await reader.readexactly(size)
            except asyncio.IncompleteReadError:
                return None
        finally:
            writer.close()
            try: await writer.wait_closed()
            except (OSError,ssl.SSLError): pass
    try:
        with patch("fi_dns_customer_policy.customer_enabled",return_value=False):
            assert await ask(cfg["hostname"]) is None
        with patch("fi_dns_customer_policy.customer_enabled",return_value=True):
            assert await ask("zzzzzzzzzzzz.fi.mnebyvpn.site") is None
            for _ in range(2):
                reply=await ask(cfg["hostname"])
                assert reply is not None and reply[-4:]==bytes.fromhex("c0000201")
            exhausted=await ask(cfg["hostname"])
            assert exhausted is not None and exhausted[3]&15==2
            assert resolver.calls==2
        print("FI_DOT_TRIAL_SHARED_QUOTA_E2E_PASS")
    finally:
        server.close()
        await server.wait_closed()

asyncio.run(main())
