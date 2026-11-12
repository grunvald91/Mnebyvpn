import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer as createTcpServer,type Server as NetServer} from 'node:net';
import {connect as connectTls,type TLSSocket,type Server as TlsServer} from 'node:tls';
import {once} from 'node:events';
import {Pool} from 'pg';
import {createPersonalDotGateway} from
  '../../packages/dns-access/src/dot-gateway.ts';
import {issuePersonalDnsAccess,revokePersonalDnsAccess} from
  '../../packages/dns-access/src/personal.ts';

const db=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:8,
});
after(async()=>db.end());

async function listen(server:TlsServer|NetServer):Promise<number>{
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const addr=server.address();
  assert.ok(addr&&typeof addr==='object');
  return addr.port;
}
async function payForDns(){
  const account=randomUUID(),order=randomUUID(),tag=randomUUID().slice(0,8);
  await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  await db.query(
    "INSERT INTO orders(id,account_id,product,provider,amount_minor,currency) "+
    "VALUES($1,$2,'smart_dns','mock',2000,'RUB')",[order,account]);
  const settlement=await db.query(
    "SELECT settle_verified_payment($1,'mock',$2,$3,$4,2000,'RUB',3600,4096) AS state",
    [order,'pay-'+tag,'capture-'+tag,'a'.repeat(64)]);
  assert.equal(settlement.rows[0].state,'APPLIED');
  const e=await db.query('SELECT id FROM entitlements WHERE source_order_id=$1',[order]);
  const entitlement=e.rows[0].id as string;
  await db.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[entitlement]);
  await db.query(
    "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
    "VALUES($1,'smart_dns',1,clock_timestamp())",[entitlement]);
  const link=await issuePersonalDnsAccess(db,account,entitlement);
  assert.ok(link&&link!=='ALREADY_ISSUED');
  return {account,entitlement,link};
}
function tlsFixture(){
  const path=mkdtempSync(join(tmpdir(),'mnebydns-tls-test-'));
  const keyFile=join(path,'test.key'),certFile=join(path,'test.crt');
  // Only ephemeral self-signed CI certificates. NEVER commit a private key
  // or trust a test certificate on production devices.
  execFileSync('openssl',[
    'req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1',
    '-subj','/CN=*.dns.mnebyvpn.site',
    '-addext','subjectAltName=DNS:*.dns.mnebyvpn.site',
    '-keyout',keyFile,'-out',certFile,
  ],{stdio:'ignore',timeout:10000});
  return {key:readFileSync(keyFile),cert:readFileSync(certFile),
    dispose:()=>rmSync(path,{recursive:true,force:true})};
}
function dnsWire(id:number):Buffer{
  const labels=['example','org'].map(x=>Buffer.concat([
    Buffer.from([x.length]),Buffer.from(x)]));
  const head=Buffer.alloc(12);
  head.writeUInt16BE(id,0);head.writeUInt16BE(0x0100,2);
  head.writeUInt16BE(1,4);
  return Buffer.concat([head,...labels,Buffer.from([0,0,1,0,1])]);
}
function framed(payload:Buffer):Buffer{
  const header=Buffer.alloc(2);
  header.writeUInt16BE(payload.length);
  return Buffer.concat([header,payload]);
}
async function connectPaid(port:number,hostname:string,ca:Buffer):Promise<TLSSocket>{
  const client=connectTls({host:'127.0.0.1',port,servername:hostname,ca,
    minVersion:'TLSv1.2',rejectUnauthorized:true});
  await once(client,'secureConnect');
  assert.equal(client.authorized,true);
  return client;
}
function oneReply(socket:TLSSocket):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(Error('DNS-over-TLS reply timed out')),2000);
    const onData=(b:Buffer)=>finish(undefined,b);
    const onClose=()=>finish(Error('DNS-over-TLS connection closed'));
    const finish=(error?:Error,data?:Buffer)=>{
      clearTimeout(timer);
      socket.off('data',onData);socket.off('close',onClose);
      if(error)reject(error);else resolve(data!);
    };
    socket.once('data',onData);socket.once('close',onClose);
  });
}
function waitClosed(socket:TLSSocket):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(socket.destroyed){resolve();return;}
    const timer=setTimeout(()=>reject(Error('Denied DoT connection remained open')),2500);
    socket.once('close',()=>{clearTimeout(timer);resolve();});
    socket.once('error',()=>{});
  });
}

test('real TLS wildcard + paid SNI forwards two CoreDNS queries; revocation cuts active socket',async()=>{
  const customer=await payForDns();
  const cert=tlsFixture();
  let forwarded=0;
  const core=createTcpServer(sock=>{
    sock.on('data',(frame:Buffer)=>{
      // Test responder: each conventional framed DNS query has one question.
      forwarded++;
      const answer=Buffer.from(frame);
      answer[4]=0x81;answer[5]=0x80; // DNS header flags QR=1, recursion available
      sock.write(answer);
    });
  });
  const corePort=await listen(core);
  const server=createPersonalDotGateway({
    key:cert.key,cert:cert.cert,db,upstreamHost:'127.0.0.1',
    upstreamPort:corePort,queryDeadlineMs:1000,
  });
  const port=await listen(server);
  let client:TLSSocket|null=null;
  try{
    client=await connectPaid(port,customer.link.hostname,cert.cert);
    for(const id of [0x1111,0x2222]){
      const promise=oneReply(client);
      client.write(framed(dnsWire(id)));
      const response=await promise;
      assert.equal(response.readUInt16BE(0),response.length-2);
      assert.equal(response.readUInt16BE(2),id);
      assert.ok(response[4]&0x80);
    }
    assert.equal(forwarded,2);
    const count=await db.query(
      "SELECT sum(authorized_queries)::text AS n FROM dns_subscription_daily_usage u "+
      "JOIN dns_subscription_links l ON u.link_id=l.id WHERE l.entitlement_id=$1",
      [customer.entitlement]);
    assert.equal(count.rows[0].n,'2');
    assert.equal(await revokePersonalDnsAccess(db,customer.account,customer.entitlement),'REVOKED');
    const closed=waitClosed(client);
    client.write(framed(dnsWire(0x3333)));
    await closed;
    assert.equal(forwarded,2);
  }finally{
    client?.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await new Promise<void>(resolve=>core.close(()=>resolve()));
    cert.dispose();
  }
});

test('unknown but syntactically valid SNI fails closed without reaching local CoreDNS',async()=>{
  const cert=tlsFixture();
  let forwarded=0;
  const core=createTcpServer(sock=>sock.on('data',()=>{forwarded++;}));
  const corePort=await listen(core);
  const server=createPersonalDotGateway({
    key:cert.key,cert:cert.cert,db,upstreamHost:'127.0.0.1',
    upstreamPort:corePort,
  });
  const port=await listen(server);
  let client:TLSSocket|null=null;
  try{
    const unknown='u'+'f'.repeat(48)+'.dns.mnebyvpn.site';
    client=await connectPaid(port,unknown,cert.cert);
    const closed=waitClosed(client);
    client.write(framed(dnsWire(0x4444)));
    await closed;
    assert.equal(forwarded,0);
  }finally{
    client?.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await new Promise<void>(resolve=>core.close(()=>resolve()));
    cert.dispose();
  }
});
