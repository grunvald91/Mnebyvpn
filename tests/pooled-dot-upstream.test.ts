import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type TLSSocket} from 'node:tls';
import type {AddressInfo} from 'node:net';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createCachedDnsResolver,createVerifiedDotPool} from '../packages/dns-policy/src/pooled-dot-upstream.ts';
import {dnsResponseMatchesQuestion} from '../packages/dns-policy/src/personal-dot-gateway-core.ts';
const dir=mkdtempSync(join(tmpdir(),'dot-pool-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=dns.test','-addext','subjectAltName=DNS:dns.test'],{stdio:'ignore'});
const key=readFileSync(join(dir,'key.pem')),cert=readFileSync(join(dir,'cert.pem'));process.once('exit',()=>rmSync(dir,{recursive:true,force:true}));
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
function question(id=713):Buffer{
  const h=Buffer.alloc(12);h.writeUInt16BE(id);h.writeUInt16BE(256,2);h.writeUInt16BE(1,4);
  return Buffer.concat([h,Buffer.from([7]),Buffer.from('example'),Buffer.from([3]),Buffer.from('org'),Buffer.from([0,0,1,0,1])]);
}
async function fixture(){
  let connections=0,requests=0;const ids:number[]=[];const sockets=new Set<TLSSocket>();
  const mode={badId:false,hang:false,delay:0,duplicate:false};
  const server=createServer({key,cert},socket=>{
    connections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let b=Buffer.alloc(0);
    socket.on('data',chunk=>{
      b=Buffer.concat([b,chunk]);
      while(b.length>=2&&b.length>=b.readUInt16BE(0)+2){
        const size=b.readUInt16BE(0),q=Buffer.from(b.subarray(2,size+2));b=b.subarray(size+2);requests++;ids.push(q.readUInt16BE());
        if(mode.hang)continue;
        const answer=Buffer.from(q);answer.writeUInt16BE(0x8180,2);
        if(mode.badId)answer.writeUInt16BE((answer.readUInt16BE()+1)&65535);
        const frame=Buffer.alloc(answer.length+2);frame.writeUInt16BE(answer.length);answer.copy(frame,2);
        const send=()=>{if(socket.destroyed)return;socket.write(frame.subarray(0,1));setImmediate(()=>{if(!socket.destroyed)socket.write(frame.subarray(1));});if(mode.duplicate)setTimeout(()=>{if(!socket.destroyed)socket.write(frame);},20).unref();};
        if(mode.delay)setTimeout(send,mode.delay);else send();
      }
    });
  });
  server.on('tlsClientError',()=>{});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  return {mode,ids,target:{address:'127.0.0.1',servername:'dns.test',port:(server.address() as AddressInfo).port,ca:cert},counts:()=>({connections,requests}),close:async()=>{for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));}};
}
test('sequential DNS queries reuse verified TLS, rotate upstream IDs and restore original IDs',async()=>{
  const f=await fixture(),pool=createVerifiedDotPool(f.target,{maxConnections:1});
  try{for(let n=0;n<8;n++){const reply=Buffer.from(await pool.query(question(73)));assert.equal(reply.readUInt16BE(),73);assert.equal(reply.readUInt16BE(2),0x8180);}
    assert.equal(f.counts().connections,1);assert.equal(f.counts().requests,8);assert.equal(new Set(f.ids).size,8);
  }finally{pool.close();await f.close();}
});
test('concurrent callers with the same ID stay bounded and receive their own replies',async()=>{
  const f=await fixture();f.mode.delay=10;const pool=createVerifiedDotPool(f.target,{maxConnections:2,maxQueued:8});
  try{const replies=await Promise.all(Array.from({length:8},()=>pool.query(question(33))));for(const r of replies)assert.equal(Buffer.from(r).readUInt16BE(),33);assert.equal(f.counts().connections,2);assert.equal(pool.stats().queued,0);}
  finally{pool.close();await f.close();}
});
test('bad trust or hostname rejects the request and never returns DNS data',async()=>{
  const f=await fixture();
  try{for(const target of [{...f.target,ca:undefined},{...f.target,servername:'wrong.test'}]){const pool=createVerifiedDotPool(target);try{await assert.rejects(pool.query(question(),1000),/TLS|certificate/i);}finally{pool.close();}}}
  finally{await f.close();}
});
test('mismatched response discards connection without retrying and next request starts fresh',async()=>{
  const f=await fixture();f.mode.badId=true;const pool=createVerifiedDotPool(f.target,{maxConnections:1});
  try{await assert.rejects(pool.query(question()),/Unmatched/);assert.equal(f.counts().requests,1);f.mode.badId=false;await pool.query(question());assert.equal(f.counts().connections,2);}
  finally{pool.close();await f.close();}
});
test('queue bounds and cancellation release only the cancelled work',async()=>{
  const f=await fixture();f.mode.delay=60;const pool=createVerifiedDotPool(f.target,{maxConnections:1,maxQueued:1});
  try{const first=pool.query(question());const controller=new AbortController(),second=pool.query(question(),1000,controller.signal);const rejected=assert.rejects(second,/aborted/);await assert.rejects(pool.query(question()),/queue is full/);controller.abort();await rejected;await first;assert.equal(f.counts().requests,1);assert.equal(pool.stats().queued,0);}
  finally{pool.close();await f.close();}
});
test('in-flight cancellation closes its TLS socket and does not reuse a late response',async()=>{
  const f=await fixture();f.mode.hang=true;const pool=createVerifiedDotPool(f.target,{maxConnections:1});
  try{const controller=new AbortController(),pending=pool.query(question(),1000,controller.signal);const rejected=assert.rejects(pending,/aborted/);for(let i=0;i<100&&!f.counts().requests;i++)await pause(5);assert.equal(f.counts().requests,1);controller.abort();await rejected;f.mode.hang=false;await pool.query(question());assert.equal(f.counts().connections,2);}
  finally{pool.close();await f.close();}
});
test('unsolicited duplicate DNS frames are not saved for the next caller',async()=>{
  const f=await fixture();f.mode.duplicate=true;const pool=createVerifiedDotPool(f.target,{maxConnections:1});
  try{await pool.query(question());await pause(60);assert.equal(pool.stats().connections,0);f.mode.duplicate=false;await pool.query(question());assert.equal(f.counts().connections,2);}
  finally{pool.close();await f.close();}
});
test('upstream timeout closes the busy channel and does not replay the timed-out query',async()=>{
  const f=await fixture();f.mode.hang=true;const pool=createVerifiedDotPool(f.target,{maxConnections:1});
  try{await assert.rejects(pool.query(question(),100),/timeout/);assert.equal(f.counts().requests,1);f.mode.hang=false;await pool.query(question());assert.equal(f.counts().requests,2);assert.equal(f.counts().connections,2);}
  finally{pool.close();await f.close();}
});
test('expired connection age renews TLS instead of leaving a full idle pool blocked',async()=>{
  const f=await fixture(),pool=createVerifiedDotPool(f.target,{maxConnections:1});const original=Date.now;let shift=0;
  try{Date.now=()=>original()+shift;await pool.query(question());shift=301000;await pool.query(question());assert.equal(f.counts().connections,2);}
  finally{Date.now=original;pool.close();await f.close();}
});
test('shutdown rejects pending requests, drains the queue and refuses new work',async()=>{
  const f=await fixture();f.mode.hang=true;const pool=createVerifiedDotPool(f.target,{maxConnections:1});
  try{const one=assert.rejects(pool.query(question()),/closed/),two=assert.rejects(pool.query(question()),/closed/);pool.close();await Promise.all([one,two]);assert.deepEqual(pool.stats(),{connections:0,busy:0,queued:0,handshakes:0});await assert.rejects(pool.query(question()),/Invalid/);}
  finally{pool.close();await f.close();}
});

test('stale idle socket disconnect retries once on fresh TLS without looping fresh failures',async()=>{
  let connections=0,requests=0,dropReused=true,dropAll=false;
  const sockets=new Set<TLSSocket>();
  const server=createServer({key,cert},socket=>{
    const connIndex=++connections;sockets.add(socket);
    socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let seenOnConn=0,b=Buffer.alloc(0);
    socket.on('data',chunk=>{
      if(dropAll||(connIndex===1&&seenOnConn>=1&&dropReused)){socket.destroy();return;}
      b=Buffer.concat([b,chunk]);
      while(b.length>=2&&b.length>=b.readUInt16BE(0)+2){
        const size=b.readUInt16BE(0),q=Buffer.from(b.subarray(2,size+2));b=b.subarray(size+2);
        seenOnConn++;requests++;
        const answer=Buffer.from(q);answer.writeUInt16BE(0x8180,2);
        const frame=Buffer.alloc(answer.length+2);frame.writeUInt16BE(answer.length);answer.copy(frame,2);
        socket.write(frame);
      }
    });
  });
  server.on('tlsClientError',()=>{});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const target={address:'127.0.0.1',servername:'dns.test',port:(server.address() as AddressInfo).port,ca:cert};
  const pool=createVerifiedDotPool(target,{maxConnections:1});
  try{
    const first=Buffer.from(await pool.query(question(101)));
    assert.equal(first.readUInt16BE(),101);
    const second=Buffer.from(await pool.query(question(102)));
    assert.equal(second.readUInt16BE(),102);
    assert.equal(connections,2);assert.equal(requests,2);
    dropAll=true;
    const prevConns=connections;
    for(const s of sockets)s.destroy();
    await pause(20);
    await assert.rejects(pool.query(question(103),1500),/disconnected|failed/);
    assert.equal(connections,prevConns+1,'fresh connection drop must not retry forever');
  }finally{
    pool.close();for(const s of sockets)s.destroy();
    await new Promise<void>(r=>server.close(()=>r()));
  }
});

function buildDnsQuery(id:number,host:string,qtype=1):Buffer{
  const hdr=Buffer.alloc(12);
  hdr.writeUInt16BE(id,0);
  hdr.writeUInt16BE(0x0100,2);
  hdr.writeUInt16BE(1,4);
  const parts:Buffer[]=[hdr];
  for(const label of host.split('.')){
    const raw=Buffer.from(label,'ascii');
    parts.push(Buffer.from([raw.length]),raw);
  }
  parts.push(Buffer.from([0]),Buffer.from([(qtype>>8)&0xff,qtype&0xff,0,1]));
  return Buffer.concat(parts);
}

function buildDnsReply(
  query:Buffer,
  {ttlSec=30,rcode=0,tc=false,ancount=1}:{ttlSec?:number;rcode?:number;tc?:boolean;ancount?:number}={},
):Buffer{
  const head=Buffer.from(query);
  let flags=0x8180|(rcode&0x0f);
  if(tc)flags|=0x0200;
  head.writeUInt16BE(flags,2);
  head.writeUInt16BE(ancount,6);
  const parts:Buffer[]=[head];
  for(let i=0;i<ancount;i++){
    const rr=Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c,0);
    rr.writeUInt16BE(1,2);
    rr.writeUInt16BE(1,4);
    rr.writeUInt32BE(ttlSec,6);
    rr.writeUInt16BE(4,10);
    rr.set([89,125,90,101],12);
    parts.push(rr);
  }
  return Buffer.concat(parts);
}

test('cached DNS resolver hits rewrite TX ID and preserve QNAME casing',async()=>{
  let calls=0;
  const cached=createCachedDnsResolver(async wire=>{
    calls++;
    return buildDnsReply(Buffer.from(wire),{ttlSec:45});
  });
  const q1=buildDnsQuery(0x1111,'www.youtube.com');
  const r1=await cached(q1);
  assert.equal(dnsResponseMatchesQuestion(q1,r1),true);
  const q2=buildDnsQuery(0xabcd,'WwW.YoUtUbE.CoM');
  const r2=await cached(q2);
  assert.equal(calls,1);
  assert.equal(Buffer.from(r2).readUInt16BE(0),0xabcd);
  assert.equal(dnsResponseMatchesQuestion(q2,r2),true);
  assert.equal(Buffer.from(r2).subarray(12,12+'www.youtube.com'.length+2).equals(q2.subarray(12,12+'www.youtube.com'.length+2)),true);
});

test('cached DNS resolver clamps positive/NODATA TTLs and expires cleanly',async()=>{
  let clock=1000,calls=0,nextTtl=1,nextAncount=1;
  const cached=createCachedDnsResolver(
    async wire=>{
      calls++;
      return buildDnsReply(Buffer.from(wire),{ttlSec:nextTtl,ancount:nextAncount});
    },
    {minTtlMs:5000,maxTtlMs:60000,nodataTtlMs:15000,now:()=>clock},
  );
  // Clamps 1s up to minTtlMs (5000ms)
  await cached(buildDnsQuery(1,'short.youtube.com'));
  clock+=4999;
  await cached(buildDnsQuery(2,'short.youtube.com'));
  assert.equal(calls,1);
  clock+=1;
  nextTtl=300;
  // Clamps 300s down to maxTtlMs (60000ms)
  await cached(buildDnsQuery(3,'short.youtube.com'));
  assert.equal(calls,2);
  clock+=59999;
  await cached(buildDnsQuery(4,'short.youtube.com'));
  assert.equal(calls,2);
  clock+=1;
  nextAncount=0;
  // NODATA uses nodataTtlMs (15000ms)
  await cached(buildDnsQuery(5,'nodata.youtube.com',28));
  assert.equal(calls,3);
  clock+=14999;
  await cached(buildDnsQuery(6,'nodata.youtube.com',28));
  assert.equal(calls,3);
  clock+=1;
  await cached(buildDnsQuery(7,'nodata.youtube.com',28));
  assert.equal(calls,4);
});

test('cached DNS resolver never caches SERVFAIL, NXDOMAIN, TC=1, or errors',async()=>{
  let calls=0;
  let behavior:'servfail'|'nxdomain'|'tc'|'error'|'ok'='servfail';
  const cached=createCachedDnsResolver(async wire=>{
    calls++;
    if(behavior==='error')throw Error('upstream boom');
    if(behavior==='servfail')return buildDnsReply(Buffer.from(wire),{rcode:2,ancount:0});
    if(behavior==='nxdomain')return buildDnsReply(Buffer.from(wire),{rcode:3,ancount:0});
    if(behavior==='tc')return buildDnsReply(Buffer.from(wire),{tc:true,ancount:1});
    return buildDnsReply(Buffer.from(wire),{ttlSec:30});
  });
  await cached(buildDnsQuery(10,'bad.example'));
  behavior='nxdomain';
  await cached(buildDnsQuery(11,'bad.example'));
  behavior='tc';
  await cached(buildDnsQuery(12,'bad.example'));
  behavior='error';
  await assert.rejects(()=>cached(buildDnsQuery(13,'bad.example')),/upstream boom/);
  behavior='ok';
  await cached(buildDnsQuery(14,'bad.example'));
  await cached(buildDnsQuery(15,'bad.example'));
  assert.equal(calls,5);
});

test('cached DNS resolver evicts least recently used entry above maxEntries',async()=>{
  let calls=0;
  const cached=createCachedDnsResolver(
    async wire=>{calls++;return buildDnsReply(Buffer.from(wire),{ttlSec:30});},
    {maxEntries:2},
  );
  await cached(buildDnsQuery(1,'a.youtube.com'));
  await cached(buildDnsQuery(2,'b.youtube.com'));
  await cached(buildDnsQuery(3,'a.youtube.com')); // refresh 'a' -> 'b' is LRU
  await cached(buildDnsQuery(4,'c.youtube.com')); // evicts 'b'
  assert.equal(calls,3);
  await cached(buildDnsQuery(5,'a.youtube.com')); // still cached
  assert.equal(calls,3);
  await cached(buildDnsQuery(6,'b.youtube.com')); // re-fetches 'b'
  assert.equal(calls,4);
});
