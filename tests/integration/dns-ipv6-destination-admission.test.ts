import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connect,createServer,type Socket,type Server} from 'node:net';
import {once} from 'node:events';
import {Pool} from 'pg';
import {identifyPaidDnsFromAcceptedSocket} from
  '../../packages/dns-ingress/src/socket-ipv6-identity.ts';
import {PostgresChunkQuota} from
  '../../packages/dns-ingress/src/postgres-chunk-quota.ts';
import {runMeteredTcpRelay,type RelayResult} from
  '../../packages/dns-ingress/src/metered-relay.ts';

const db=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:6,
});
after(async()=>db.end());

async function listen(server:Server,host:string):Promise<number>{
  server.listen({port:0,host});
  await once(server,'listening');
  const address=server.address();
  assert.ok(address&&typeof address==='object');
  return address.port;
}
async function dial(port:number,host:string):Promise<Socket>{
  const socket=connect({port,host});
  await once(socket,'connect');
  return socket;
}
async function subscriberForLoopback():Promise<string>{
  const acct=randomUUID(),order=randomUUID(),suffix=randomUUID().slice(0,12);
  await db.query('INSERT INTO accounts(id) VALUES($1)',[acct]);
  await db.query(`INSERT INTO orders(
    id,account_id,product,provider,amount_minor,currency)
    VALUES($1,$2,'smart_dns','mock',10000,'RUB')`,[order,acct]);
  const paid=await db.query(
    `SELECT settle_verified_payment($1,'mock',$2,$3,$4,10000,'RUB',3600,1024) AS status`,
    [order,'event-'+suffix,'capture-'+suffix,'b'.repeat(64)]);
  assert.equal(paid.rows[0].status,'APPLIED');
  const ent=(await db.query('SELECT id FROM entitlements WHERE source_order_id=$1',
    [order])).rows[0].id as string;
  await db.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[ent]);
  await db.query(`INSERT INTO provisioning_state(
    entitlement_id,adapter,applied_revision,last_observed_at)
    VALUES($1,'smart_dns',1,clock_timestamp())`,[ent]);
  const claim=await db.query(
    'SELECT claim_smart_dns_ipv6($1::uuid,$2::inet) AS status',[ent,'::1']);
  assert.equal(claim.rows[0].status,'BOUND');
  return ent;
}
function readExactly(socket:Socket,length:number):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    const pieces:Buffer[]=[];
    let total=0;
    const timeout=setTimeout(()=>finish(Error('IPv6 loopback data timeout')),4000);
    const onData=(b:Buffer)=>{
      pieces.push(b);
      total+=b.length;
      if(total>=length)finish();
    };
    const onClose=()=>finish(Error('IPv6 socket closed before data'));
    const finish=(err?:Error)=>{
      clearTimeout(timeout);
      socket.off('data',onData);
      socket.off('close',onClose);
      if(err)reject(err);else resolve(Buffer.concat(pieces));
    };
    socket.on('data',onData);
    socket.once('close',onClose);
  });
}

test('real ::1 accepted socket is mapped to exactly one paid reservation in PostgreSQL',async()=>{
  const ent=await subscriberForLoopback();
  const echo=createServer(s=>s.on('data',(b:Buffer)=>s.write(b)));
  const echoPort=await listen(echo,'127.0.0.1');
  const relayDone:Promise<RelayResult>[]=[];
  const relay=createServer({allowHalfOpen:true},async accepted=>{
    accepted.pause();
    // Auth occurs BEFORE initiating any outbound connection.
    const identity=await identifyPaidDnsFromAcceptedSocket(accepted,db);
    if(!identity){accepted.destroy();return;}
    const upstream=connect({host:'127.0.0.1',port:echoPort,allowHalfOpen:true});
    try{
      await once(upstream,'connect');
      const running=runMeteredTcpRelay({
        client:accepted,upstream,identity,quota:new PostgresChunkQuota(db),
        maxChunkBytes:64,recheckMs:80,
      });
      relayDone.push(running.done);
      accepted.resume();
    }catch{accepted.destroy();upstream.destroy();}
  });
  const port=await listen(relay,'::1');
  const client=await dial(port,'::1');
  try{
    const payload=Buffer.alloc(128,0x51);
    const echoed=readExactly(client,payload.length);
    client.write(payload);
    assert.deepEqual(await echoed,payload);
    client.end();
    await Promise.race([
      once(client,'close'),
      new Promise((_,reject)=>setTimeout(()=>reject(Error('IPv6 close timeout')),3000)),
    ]);
    assert.equal(relayDone.length,1);
    const result=await relayDone[0];
    assert.equal(result.uploadBytes,128);
    assert.equal(result.downloadBytes,128);
    const used=await db.query('SELECT quota_used_bytes FROM entitlements WHERE id=$1',[ent]);
    assert.equal(String(used.rows[0].quota_used_bytes),'256');
  }finally{
    client.destroy();
    await new Promise<void>(resolve=>relay.close(()=>resolve()));
    await new Promise<void>(resolve=>echo.close(()=>resolve()));
  }
});

test('IPv4 TCP socket never inherits paid IPv6 identity or opens upstream',async()=>{
  let upstreamConnections=0;
  const relay=createServer({allowHalfOpen:true},async accepted=>{
    accepted.pause();
    const identity=await identifyPaidDnsFromAcceptedSocket(accepted,db);
    if(identity)upstreamConnections++;
    accepted.destroy();
  });
  const port=await listen(relay,'127.0.0.1');
  const client=await dial(port,'127.0.0.1');
  try{
    await Promise.race([
      once(client,'close'),
      new Promise((_,reject)=>setTimeout(()=>reject(Error('IPv4 denial timeout')),2500)),
    ]);
    assert.equal(upstreamConnections,0);
  }finally{
    client.destroy();
    await new Promise<void>(resolve=>relay.close(()=>resolve()));
  }
});
