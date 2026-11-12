/** Real TLS/DoT + real disposable PostgreSQL + two DNS/TCP upstreams.
 * No DNS:853, SSH, customer subscription, public IP or existing CoreDNS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer as createTcpServer,type Server as TcpServer,type AddressInfo} from 'node:net';
import {connect as connectTls,type TLSSocket} from 'node:tls';
import {Pool} from 'pg';
import {createPersonalDotListener,queryLoopbackDnsTcp}
  from '../../packages/dns-policy/src/personal-dot-listener.ts';
import {makePersonalDoTIdentity} from '../../packages/dns-policy/src/personal-dot-identity.ts';
import {pinnedCanaryPolicy} from '../../apps/service/src/personal-dot-canary.ts';

const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const port=(server:TcpServer)=> (server.address() as AddressInfo).port;
function makeQuery(name:string,id=0x2468):Buffer{
 const head=Buffer.alloc(12);
 head.writeUInt16BE(id,0);head.writeUInt16BE(0x0100,2);head.writeUInt16BE(1,4);
 return Buffer.concat([head,...name.split('.').map(s=>
  Buffer.concat([Buffer.from([s.length]),Buffer.from(s)])),Buffer.from([0,0,1,0,1])]);
}
function response(query:Buffer,rcode:number):Buffer{
 const result=Buffer.from(query);
 result.writeUInt16BE(0x8180|rcode,2);return result;
}
function framed(wire:Buffer):Buffer{
 const result=Buffer.alloc(2+wire.length);
 result.writeUInt16BE(wire.length,0);wire.copy(result,2);return result;
}
async function mockDns(rcode:number):Promise<{server:TcpServer,count:()=>number}>{
 let count=0;
 const server=createTcpServer(socket=>{
  let input=Buffer.alloc(0);
  socket.on('error',()=>{});
  socket.on('data',chunk=>{
   input=Buffer.concat([input,chunk]);
   if(input.length<2)return;
   const n=input.readUInt16BE(0);
   if(input.length<n+2)return;
   count++;
   socket.end(framed(response(input.subarray(2,n+2),rcode)));
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{server,count:()=>count};
}
function tlsClient(cert:Buffer,portNumber:number,hostname:string):Promise<TLSSocket>{
 return new Promise((resolve,reject)=>{
  const socket=connectTls({host:'127.0.0.1',port:portNumber,servername:hostname,
   rejectUnauthorized:true,ca:cert});
  socket.once('secureConnect',()=>resolve(socket));
  socket.once('error',reject);
 });
}
function clientFrames(socket:TLSSocket){
 let incoming=Buffer.alloc(0);
 const waiting:Array<{resolve:(b:Buffer)=>void,reject:(e:Error)=>void}>=[], ready:Buffer[]=[];
 socket.on('data',(chunk:Buffer)=>{
  incoming=Buffer.concat([incoming,chunk]);
  while(incoming.length>=2){
   const n=incoming.readUInt16BE(0);
   if(incoming.length<n+2)break;
   const item=Buffer.from(incoming.subarray(2,2+n));
   incoming=incoming.subarray(2+n);
   if(waiting.length)waiting.shift()!.resolve(item);else ready.push(item);
  }
 });
 socket.on('close',()=>{
  while(waiting.length)waiting.shift()!.reject(Error('TLS socket closed'));
 });
 return{
  send(q:Buffer):Promise<Buffer>{
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('No framed TLS DNS reply')),4500);
    waiting.push({resolve:b=>{clearTimeout(timer);resolve(b);},
      reject:e=>{clearTimeout(timer);reject(e);}});
    socket.write(framed(q));
   });
  },
  async expectClosed(q:Buffer):Promise<void>{
   if(socket.destroyed)return;
   const closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()));
   socket.write(framed(q));
   await Promise.race([closed,wait(4500).then(()=>{throw Error('Expected TLS close');})]);
  },
 };
}

test('private canary DoT TLS + DB + origin/mapped DNS roundtrip and measured latency',
 {timeout:50000},async()=>{
 const tmp=mkdtempSync(join(tmpdir(),'mnebydns-canary-'));
 const keyPath=join(tmp,'test.key'),certPath=join(tmp,'test.crt');
 let mapped:Awaited<ReturnType<typeof mockDns>>|undefined;
 let direct:Awaited<ReturnType<typeof mockDns>>|undefined;
 let listener:ReturnType<typeof createPersonalDotListener>|undefined;
 const db=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:8});
 const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
 const first=makePersonalDoTIdentity(undefined,new Uint8Array(16).fill(71));
 const second=makePersonalDoTIdentity(undefined,new Uint8Array(16).fill(82));
 let outage=false,client:TLSSocket|undefined;
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes',
   '-keyout',keyPath,'-out',certPath,'-days','1',
   '-subj','/CN=*.dns.mnebyvpn.site',
   '-addext','subjectAltName=DNS:*.dns.mnebyvpn.site'],{stdio:'ignore'});
  const cert=readFileSync(certPath),key=readFileSync(keyPath);
  await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  await db.query(`INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
    VALUES($1,$2,'smart_dns','fixture',20000,'RUB','PAID')`,[order,account]);
  await db.query(`INSERT INTO entitlements(
    id,account_id,source_order_id,product,state,revision,starts_at,expires_at,quota_limit_bytes)
    VALUES($1,$2,$3,'smart_dns','ACTIVE',1,clock_timestamp()-interval '5 minutes',
      clock_timestamp()+interval '30 days',1000000)`,[entitlement,account,order]);
  const provision=await db.query(
    'SELECT issue_personal_dns_credential($1,$2,$3,$4) AS verdict',
    [entitlement,first.label,first.tokenSha256,30]);
  assert.equal(provision.rows[0].verdict,'ISSUED');

  mapped=await mockDns(0);
  direct=await mockDns(3);
  const policyBytes=Buffer.from(JSON.stringify(['claude.ai','*.premium.example']));
  const classifier=pinnedCanaryPolicy(policyBytes,createHash('sha256').update(policyBytes).digest('hex'));
  assert.equal(classifier({name:'claude.ai',type:1,dnsClass:1}),'premium');
  assert.equal(classifier({name:'example.org',type:1,dnsClass:1}),'direct');
  assert.throws(()=>pinnedCanaryPolicy(policyBytes,'0'.repeat(64)),/digest mismatch/);
  const sourceDb={
   query:(sql:string,params?:unknown[])=>{
    if(outage)throw Error('PostgreSQL connection unavailable');
    return db.query(sql,params);
   },
  } as unknown as Pick<Pool,'query'>;
  listener=createPersonalDotListener({
   key,cert,db:sourceDb,classify:classifier,queryTimeoutMs:3500,
   mapped:(wire,signal)=>queryLoopbackDnsTcp({host:'127.0.0.1',port:port(mapped!.server)},wire,2000,signal),
   direct:(wire,signal)=>queryLoopbackDnsTcp({host:'127.0.0.1',port:port(direct!.server)},wire,2000,signal),
  });
  await new Promise<void>(resolve=>listener!.listen(0,'127.0.0.1',resolve));
  const listenPort=(listener.address() as AddressInfo).port;
  client=await tlsClient(cert,listenPort,first.hostname);
  const io=clientFrames(client);
  assert.equal((await io.send(makeQuery('example.org'))).readUInt16BE(2)&15,3);
  assert.equal((await io.send(makeQuery('claude.ai'))).readUInt16BE(2)&15,0);
  assert.equal(mapped.count(),1);
  assert.equal(direct.count(),1);
  const latencies:number[]=[];
  for(let i=0;i<12;i++){
   const begin=performance.now();
   const reply=await io.send(makeQuery('claude.ai',0x3000+i));
   assert.equal(reply.readUInt16BE(2)&15,0);
   latencies.push(performance.now()-begin);
  }
  latencies.sort((a,b)=>a-b);
  const p50=latencies[Math.floor(latencies.length*.5)]!;
  const p95=latencies[Math.ceil(latencies.length*.95)-1]!;
  console.info('MNEBYDNS_CANARY_LOCAL_PREMIUM_RTT_MS_P50='+p50.toFixed(1));
  console.info('MNEBYDNS_CANARY_LOCAL_PREMIUM_RTT_MS_P95='+p95.toFixed(1));
  const used=await db.query('SELECT * FROM personal_dns_query_status($1)',[entitlement]);
  assert.equal(BigInt(used.rows[0].used_queries),13n);
  assert.equal(BigInt(used.rows[0].remaining_queries),17n);
  outage=true;
  assert.equal((await io.send(makeQuery('claude.ai'))).readUInt16BE(2)&15,3);
  outage=false;
  const changed=await db.query(
   'SELECT rotate_personal_dns_credential($1,$2,$3,$4,$5) AS verdict',
   [account,entitlement,1,second.label,second.tokenSha256]);
  assert.equal(changed.rows[0].verdict,'ROTATED');
  await io.expectClosed(makeQuery('example.org'));
  client.destroy();
  client=await tlsClient(cert,listenPort,second.hostname);
  const fresh=clientFrames(client);
  assert.equal((await fresh.send(makeQuery('claude.ai'))).readUInt16BE(2)&15,0);
  const final=await db.query('SELECT * FROM personal_dns_query_status($1)',[entitlement]);
  assert.equal(BigInt(final.rows[0].used_queries),14n);
  console.info('MNEBYDNS_CANARY_LOCAL_END_TO_END=PASS');
 }finally{
  client?.destroy();
  if(listener)await new Promise<void>(resolve=>listener!.close(()=>resolve()));
  if(mapped)await new Promise<void>(resolve=>mapped!.server.close(()=>resolve()));
  if(direct)await new Promise<void>(resolve=>direct!.server.close(()=>resolve()));
  await db.query('DELETE FROM personal_dns_query_reservations WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
  await db.query('DELETE FROM personal_dns_query_windows WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
  await db.query('DELETE FROM personal_dns_credentials WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
  await db.query('DELETE FROM entitlements WHERE id=$1',[entitlement]).catch(()=>{});
  await db.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
  await db.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
  await db.end();
  rmSync(tmp,{recursive:true,force:true});
 }
});
