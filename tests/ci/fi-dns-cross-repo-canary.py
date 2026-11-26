"""Disposable cross-repository FI DNS canary. No production network or keys."""
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
from fi_dns_signed_grants import validate, authorized, hostname_digest, message
import fi_dns_pilot
import fi_dns_tls_session as session

async def main():
    root=Path(sys.argv[1])
    cfg=json.loads((root/"fixture.json").read_text())
    snap=json.loads((root/"snapshot.json").read_text())
    validate(snap,time.time())
    openssl_verify(root/"controller.pub",base64.urlsafe_b64decode(snap["signature"]+"=="),message(snap))
    class Authorizer:
        async def allowed(self,hostname):
            return authorized(snap,hostname)[0]
    class Resolver:
        def __init__(self): self.calls=0
        async def resolve(self,query):
            self.calls+=1
            # Real DNS wire A answer, deterministic CI-only origin.
            return query[:2]+bytes.fromhex("81800001000100000000")+query[12:]+bytes.fromhex("c00c000100010000003c0004c0000201")
    meter=SignedQueryMeter(LoopbackMeterTransport(cfg["port"]),
        lambda msg:openssl_sign(root/"node.key",msg),
        lambda msg,sig:openssl_verify(root/"controller.pub",sig,msg))
    resolver=Resolver()
    marker = root / "pilot-permit"
    pilot = fi_dns_pilot.PilotGrant(marker)
    authorizer = fi_dns_pilot.PilotAuthorizer(Authorizer(), pilot)
    now = int(time.time())
    permit = f"{hostname_digest(cfg['hostname'])} {now} {now + 90}\n"

    def arm():
        marker.write_text(permit)
        marker.chmod(0o600)

    # Test certificate only. Use actual production SNI binding and TLS
    # framing, replacing the staged LE file location and preflight in CI.
    with patch.object(session,"REGIONAL_CERT_DIR",root),patch.object(session,"verify_pair"):
        server=await session.make_metered_loopback_server(authorizer=authorizer,meter=meter,resolver=resolver,listen_port=0)
    ctx=ssl.create_default_context(cafile=str(root/"fullchain.pem"))
    query=bytes.fromhex("123401000001000000000000076578616d706c6503636f6d0000010001")
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
    # The isolated runner is not root. File ownership is separately tested
    # in Nodekit CI and this fixture still exercises the actual permit parser.
    try:
        with patch.object(fi_dns_pilot, "private_dir"), patch.object(fi_dns_pilot, "read", side_effect=lambda path, _: path.read_bytes()):
            assert await ask(cfg["hostname"]) is None
            arm()
            assert pilot.accepts_snapshot(snap["grants"])
            assert await ask("zzzzzzzzzzzz.fi.mnebyvpn.site") is None
            reply=await ask(cfg["hostname"])
            assert reply is not None and reply[-4:]==bytes.fromhex("c0000201")
            marker.unlink()
            assert await ask(cfg["hostname"]) is None
            assert resolver.calls == 1
            arm()
            reply=await ask(cfg["hostname"])
            assert reply is not None and reply[-4:]==bytes.fromhex("c0000201")
            assert await ask(cfg["hostname"]) is None
            assert resolver.calls==2
        print("FI_DOT_PILOT_SIGNED_QUOTA_AND_REVOKE_E2E_PASS")
    finally:
        server.close()
        await server.wait_closed()

asyncio.run(main())
