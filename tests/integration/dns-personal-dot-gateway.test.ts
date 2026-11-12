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
function tlsFixture(name='*.dns.mnebyvpn.site'){
  const path=mkdtempSync(join(tmpdir(),'mnebydns-tls-test-'));
  const keyFile=join(path,'test.key'),certFile=join(path,'test.crt');
  // Only ephemeral self-signed CI certificates. NEVER commit a private key
  // or trust a test certificate on production devices.
  execFileSync('openssl',[
    'req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1',
    '-subj','/CN='+name,
    '-addext','subjectAltName=DNS:'+name,
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


test('gateway rejects a certificate not covering subscriber DoT names before listening',()=>{
  const cert=tlsFixture('unrelated.example.test');
  try{
    assert.throws(()=>createPersonalDotGateway({
      key:cert.key,cert:cert.cert,db,upstreamHost:'127.0.0.1',
      upstreamPort:53,
    }),/certificate does not cover customer hostnames/);
  }finally{cert.dispose();}
});

test('duplicate DNS transaction IDs and oversized simultaneous query batches are denied',async()=>{
  const customer=await payForDns(),cert=tlsFixture();
  let forwarded=0;
  const core=createTcpServer(s=>s.on('data',()=>{forwarded++;}));
  const corePort=await listen(core);
  const gateway=createPersonalDotGateway({
    key:cert.key,cert:cert.cert,db,upstreamHost:'127.0.0.1',
    upstreamPort:corePort,
  });
  const port=await listen(gateway);
  let client:TLSSocket|null=null;
  try{
    client=await connectPaid(port,customer.link.hostname,cert.cert);
    const closed=waitClosed(client);
    client.write(Buffer.concat([
      framed(dnsWire(0x1234)),framed(dnsWire(0x1234)),
    ]));
    await closed;
    assert.equal(forwarded,0,'do not forward an ambiguous duplicate request');
    client=await connectPaid(port,customer.link.hostname,cert.cert);
    const batch=Buffer.concat(
      Array.from({length:33},(_,i)=>framed(dnsWire(0x7000+i))));
    const rejected=waitClosed(client);
    client.write(batch);
    await rejected;
    assert.equal(forwarded,0,'do not forward an over-limit batch');
  }finally{
    client?.destroy();
    await new Promise<void>(resolve=>gateway.close(()=>resolve()));
    await new Promise<void>(resolve=>core.close(()=>resolve()));
    cert.dispose();
  }
});

test('unsolicited or mismatched CoreDNS response IDs never leak onto TLS client',async()=>{
  const customer=await payForDns(),cert=tlsFixture();
  let forwarded=0,clientData=0;
  const core=createTcpServer(s=>s.on('data',(frame:Buffer)=>{
    forwarded++;
    const bogus=Buffer.from(frame);
    bogus.writeUInt16BE(0x9999,2); // different DNS transaction ID
    bogus[4]=0x81;bogus[5]=0x80;
    s.write(bogus);
  }));
  const corePort=await listen(core);
  const gateway=createPersonalDotGateway({
    key:cert.key,cert:cert.cert,db,upstreamHost:'127.0.0.1',
    upstreamPort:corePort,
  });
  const port=await listen(gateway);
  let client:TLSSocket|null=null;
  try{
    client=await connectPaid(port,customer.link.hostname,cert.cert);
    client.on('data',()=>clientData++);
    const rejected=waitClosed(client);
    client.write(framed(dnsWire(0x8888)));
    await rejected;
    assert.equal(forwarded,1);
    assert.equal(clientData,0,'do not forward a response for an unknown query ID');
  }finally{
    client?.destroy();
    await new Promise<void>(resolve=>gateway.close(()=>resolve()));
    await new Promise<void>(resolve=>core.close(()=>resolve()));
    cert.dispose();
  }
});

test('fragmented DNS-over-TCP responses and pipelined unique queries are preserved',async()=>{
  const customer=await payForDns(),cert=tlsFixture();
  let forwarded=0,coreBuffer=Buffer.alloc(0);
  const core=createTcpServer(s=>s.on('data',(data:Buffer)=>{
    coreBuffer=Buffer.concat([coreBuffer,data]);
    const ready:Buffer[]=[];
    while(coreBuffer.length>=2){
      const len=coreBuffer.readUInt16BE(0);
      if(coreBuffer.length<len+2)break;
      const reply=Buffer.from(coreBuffer.subarray(0,len+2));
      reply[4]=0x81;reply[5]=0x80;
      ready.push(reply);
      coreBuffer=coreBuffer.subarray(len+2);
      forwarded++;
    }
    if(ready.length===2){
      const combined=Buffer.concat(ready);
      s.write(combined.subarray(0,3));
      s.write(combined.subarray(3,combined.length-4));
      s.write(combined.subarray(combined.length-4));
    }else if(ready.length===1 && forwarded===1){
      // First reply may precede second query's authorization: buffer it until
      // both queries have arrived. Only this integration fake behaves so.
      (s as typeof s & {firstResponse?:Buffer}).firstResponse=ready[0];
    }
    if(forwarded===2){
      const first=(s as typeof s & {firstResponse?:Buffer}).firstResponse;
      const latest=ready.at(-1);
      if(first&&latest){
        const combined=Buffer.concat([first,latest]);
        s.write(combined.subarray(0,3));
        s.write(combined.subarray(3,combined.length-4));
        s.write(combined.subarray(combined.length-4));
      }
    }
  }));
  const corePort=await listen(core);
  const gateway=createPersonalDotGateway({
    key:cert.key,cert:cert.cert,db,upstreamHost:'127.0.0.1',
    upstreamPort:corePort,
  });
  const port=await listen(gateway);
  let client:TLSSocket|null=null;
  try{
    client=await connectPaid(port,customer.link.hostname,cert.cert);
    const expected=[0x1515,0x2525],seen:number[]=[];
    let buffer=Buffer.alloc(0);
    const received=new Promise<void>((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(Error('Fragmented DNS replies timed out')),5000);
      client!.on('data',(data:Buffer)=>{
        buffer=Buffer.concat([buffer,data]);
        while(buffer.length>=2){
          const size=buffer.readUInt16BE(0);
          if(buffer.length<size+2)break;
          seen.push(buffer.readUInt16BE(2));
          buffer=buffer.subarray(size+2);
        }
        if(seen.length===2){clearTimeout(deadline);resolve();}
      });
      client!.on('close',()=>{clearTimeout(deadline);reject(Error('DNS gateway unexpectedly closed'));});
    });
    const both=Buffer.concat(expected.map(id=>framed(dnsWire(id))));
    client.write(both.subarray(0,5));
    client.write(both.subarray(5));
    await received;
    assert.deepEqual(seen,expected);
    assert.equal(forwarded,2);
  }finally{
    client?.destroy();
    await new Promise<void>(resolve=>gateway.close(()=>resolve()));
    await new Promise<void>(resolve=>core.close(()=>resolve()));
    cert.dispose();
  }
});
