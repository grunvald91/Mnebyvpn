import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer, connect, type Server, type Socket} from 'node:net';
import {once} from 'node:events';
import {Pool} from 'pg';
import {PostgresChunkQuota, type TrustedEntitlement} from
  '../../packages/dns-ingress/src/postgres-chunk-quota.ts';
import {runMeteredTcpRelay, type RelayResult} from
  '../../packages/dns-ingress/src/metered-relay.ts';

// OFFLINE ONLY: synthetic per-listener identity; the internet-facing
// destination-IP/DoT identity proof is NOT implemented by this test.
const pool=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
  max:8,connectionTimeoutMillis:5000,
});
after(async()=>pool.end());
const quota=new PostgresChunkQuota(pool);

async function paidSubscriber(limit:number):Promise<TrustedEntitlement>{
  const accountId=randomUUID(),orderId=randomUUID(),tag=randomUUID().slice(0,12);
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[accountId]);
  await pool.query(`INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
    VALUES($1,$2,'smart_dns','mock',10000,'RUB')`,[orderId,accountId]);
  const payment=await pool.query(`SELECT settle_verified_payment(
    $1,'mock',$2,$3,$4,10000,'RUB',3600,$5) AS status`,
    [orderId,'event-'+tag,'capture-'+tag,'a'.repeat(64),limit]);
  assert.equal(payment.rows[0].status,'APPLIED');
  const ent=(await pool.query('SELECT id,revision FROM entitlements WHERE source_order_id=$1',
    [orderId])).rows[0];
  await pool.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[ent.id]);
  await pool.query(`INSERT INTO provisioning_state(
    entitlement_id,adapter,applied_revision,last_observed_at)
    VALUES($1,'smart_dns',$2,clock_timestamp())`,[ent.id,ent.revision]);
  return {entitlementId:ent.id as string,revision:String(ent.revision)};
}
async function listen(server:Server):Promise<number>{
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const a=server.address();
  assert.ok(a&&typeof a==='object');
  return a.port;
}
async function dial(port:number):Promise<Socket>{
  const socket=connect({host:'127.0.0.1',port});
  await once(socket,'connect');
  return socket;
}
function receive(socket:Socket,expectedBytes:number):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    let total=0;
    const chunks:Buffer[]=[];
    const deadline=setTimeout(()=>done(new Error('loopback echo timeout')),4000);
    const onData=(data:Buffer)=>{
      chunks.push(data);
      total+=data.length;
      if(total>=expectedBytes)done();
    };
    const onClose=()=>done(new Error('socket closed before full echo'));
    const done=(error?:Error)=>{
      clearTimeout(deadline);
      socket.off('data',onData);
      socket.off('close',onClose);
      if(error)reject(error);
      else resolve(Buffer.concat(chunks));
    };
    socket.on('data',onData);
    socket.once('close',onClose);
  });
}

test('real loopback TCP echo is billed by PostgreSQL for BOTH payload directions',async()=>{
  const identity=await paidSubscriber(4096);
  const echo=createServer(s=>s.on('data',data=>{s.write(data);}));
  const echoPort=await listen(echo);
  const finished:Promise<RelayResult>[]=[];
  const relay=createServer(async downstream=>{
    downstream.pause();
    const upstream=connect({host:'127.0.0.1',port:echoPort});
    try{
      await once(upstream,'connect');
      const session=runMeteredTcpRelay({
        client:downstream,upstream,identity,quota,
        maxChunkBytes:128,recheckMs:100,
      });
      finished.push(session.done);
      downstream.resume();
    }catch{downstream.destroy();upstream.destroy();}
  });
  const port=await listen(relay);
  const client=await dial(port);
  try{
    const payload=Buffer.alloc(384,0x52);
    const received=receive(client,payload.length);
    client.write(payload);
    assert.deepEqual(await received,payload);
    client.end();
    await once(client,'close');
    assert.equal(finished.length,1);
    const result=await finished[0];
    assert.equal(result.uploadBytes,payload.length);
    assert.equal(result.downloadBytes,payload.length);
    const ent=await pool.query(
      'SELECT quota_used_bytes FROM entitlements WHERE id=$1',[identity.entitlementId]);
    assert.equal(ent.rows[0].quota_used_bytes,String(payload.length*2));
    const ledger=await pool.query(`SELECT
       COALESCE(sum(upload_bytes),0)::bigint AS upload,
       COALESCE(sum(download_bytes),0)::bigint AS download
       FROM smart_dns_measured_traffic WHERE entitlement_id=$1`,
       [identity.entitlementId]);
    assert.equal(ledger.rows[0].upload,String(payload.length));
    assert.equal(ledger.rows[0].download,String(payload.length));
  }finally{
    client.destroy();
    await new Promise<void>(resolve=>relay.close(()=>resolve()));
    await new Promise<void>(resolve=>echo.close(()=>resolve()));
  }
});

test('TCP transport stops on paid byte cap instead of forwarding the full buffer',async()=>{
  const identity=await paidSubscriber(128);
  const echo=createServer(s=>s.on('data',data=>{s.write(data);}));
  const echoPort=await listen(echo);
  const finished:Promise<RelayResult>[]=[];
  const relay=createServer(async downstream=>{
    downstream.pause();
    const upstream=connect({host:'127.0.0.1',port:echoPort});
    try{
      await once(upstream,'connect');
      const session=runMeteredTcpRelay({
        client:downstream,upstream,identity,quota,maxChunkBytes:32,recheckMs:30,
      });
      finished.push(session.done);
      downstream.resume();
    }catch{downstream.destroy();upstream.destroy();}
  });
  const port=await listen(relay);
  const client=await dial(port);
  const received:Buffer[]=[];
  client.on('data',d=>received.push(d));
  try{
    client.write(Buffer.alloc(256,0x61));
    await Promise.race([
      once(client,'close'),
      new Promise((_,reject)=>setTimeout(
        ()=>reject(new Error('quota cutoff timeout')),4000)),
    ]);
    assert.equal(finished.length,1);
    const result=await finished[0];
    assert.ok(
      result.stopReason==='quota-denied'||result.stopReason==='revoked',
      result.stopReason);
    assert.ok(result.uploadBytes+result.downloadBytes<=128);
    const total=(await pool.query('SELECT quota_used_bytes FROM entitlements WHERE id=$1',
      [identity.entitlementId])).rows[0].quota_used_bytes;
    assert.ok(Number(total)>0 && Number(total)<=128);
    assert.equal(Number(total),result.uploadBytes+result.downloadBytes);
    assert.ok(Buffer.concat(received).length<=128);
  }finally{
    client.destroy();
    await new Promise<void>(resolve=>relay.close(()=>resolve()));
    await new Promise<void>(resolve=>echo.close(()=>resolve()));
  }
});

test('SQL revocation cuts an already open TCP relay with no new payload billed',async()=>{
  const identity=await paidSubscriber(4096);
  const echo=createServer(s=>s.on('data',data=>{s.write(data);}));
  const echoPort=await listen(echo);
  const results:Promise<RelayResult>[]=[];
  const relay=createServer(async downstream=>{
    downstream.pause();
    const upstream=connect({host:'127.0.0.1',port:echoPort});
    try{
      await once(upstream,'connect');
      const session=runMeteredTcpRelay({
        client:downstream,upstream,identity,quota,maxChunkBytes:64,recheckMs:30,
      });
      results.push(session.done);
      downstream.resume();
    }catch{downstream.destroy();upstream.destroy();}
  });
  const port=await listen(relay);
  const client=await dial(port);
  try{
    const payload=Buffer.alloc(64,0x5a);
    const received=receive(client,payload.length);
    client.write(payload);
    assert.deepEqual(await received,payload);
    // Invalidate the entitlement AFTER a fully settled transfer while the
    // TCP socket is still open and idle.
    await pool.query(`UPDATE entitlements SET state='EXPIRED',revision=revision+1
      WHERE id=$1`,[identity.entitlementId]);
    await Promise.race([
      once(client,'close'),
      new Promise((_,reject)=>setTimeout(()=>reject(Error('revocation cutoff timeout')),3000)),
    ]);
    assert.equal(results.length,1);
    const result=await results[0];
    assert.equal(result.stopReason,'revoked');
    assert.equal(result.uploadBytes,64);
    assert.equal(result.downloadBytes,64);
    const usage=await pool.query('SELECT quota_used_bytes FROM entitlements WHERE id=$1',
      [identity.entitlementId]);
    assert.equal(usage.rows[0].quota_used_bytes,'128');
  }finally{
    client.destroy();
    await new Promise<void>(resolve=>relay.close(()=>resolve()));
    await new Promise<void>(resolve=>echo.close(()=>resolve()));
  }
});

test('missing trusted identity closes loopback TCP without forwarding',async()=>{
  const echo=createServer(s=>s.on('data',data=>{s.write(data);}));
  const echoPort=await listen(echo);
  const relay=createServer(async downstream=>{
    downstream.pause();
    const upstream=connect({host:'127.0.0.1',port:echoPort});
    try{
      await once(upstream,'connect');
      runMeteredTcpRelay({client:downstream,upstream,identity:null,quota});
    }catch{downstream.destroy();upstream.destroy();}
  });
  const port=await listen(relay);
  const client=await dial(port);
  try{
    await Promise.race([
      once(client,'close'),
      new Promise((_,reject)=>setTimeout(()=>reject(Error('unauthorized socket open')),3000)),
    ]);
  }finally{
    client.destroy();
    await new Promise<void>(resolve=>relay.close(()=>resolve()));
    await new Promise<void>(resolve=>echo.close(()=>resolve()));
  }
});
