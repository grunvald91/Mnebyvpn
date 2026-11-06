import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {PgReconcileStore,ReconcileLockBusy} from '../../packages/provisioning/src/pg-worker.ts';
const pool=new Pool({host:process.env.PGHOST??'localhost',
  port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:2,connectionTimeoutMillis:1500});
const billing=new PgBillingStore(pool),store=new PgReconcileStore(pool);
const suffix=randomUUID().slice(0,8),plan='lock-'+suffix;
after(async()=>pool.end());
async function entitlement(user:number,key:string){
 await pool.query("INSERT INTO billing_plans(id,product,title,duration_seconds,stars,enabled) "+
  "VALUES($1,'vpn','Lock test',86400,19,true) ON CONFLICT DO NOTHING",[plan]);
 const o=await billing.createTelegramOrder(user,plan,key);
 await billing.settleVerified({provider:'telegram_stars',orderId:o.id,
  providerEventId:'event:'+key,providerTransactionId:'transaction:'+key,
  payloadHash:'a'.repeat(64),amount:19,currency:'XTR'});
 const r=await pool.query('SELECT id FROM entitlements WHERE source_order_id=$1',[o.id]);
 return String(r.rows[0].id);
}
test('max=2 pool, same entitlement concurrent locks never deadlock',async()=>{
 const id=await entitlement(99440001,'lock-one-'+suffix);
 let unlock!:()=>void;
 const hold=new Promise<void>(resolve=>unlock=resolve);
 let entered!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve);
 const first=store.withLock(id,async()=>{
  entered();
  const d=await store.readDesired(id);
  assert.equal(d.enabled,true);
  await hold;
  await store.requestReconcile(id,'test_reason');
  return 42;
 });
 await started;
 await assert.rejects(store.withLock(id,async()=>99),ReconcileLockBusy);
 unlock();
 assert.equal(await first,42);
});
test('max=2 pool, two DIFFERENT entitlements use their locked connections',async()=>{
 const a=await entitlement(99440002,'lock-two-'+suffix);
 const b=await entitlement(99440003,'lock-three-'+suffix);
 const completed=await Promise.race([
   Promise.all([a,b].map(id=>store.withLock(id,async()=>{
     const d=await store.readDesired(id);
     assert.equal(d.enabled,true);
     await store.requestReconcile(id,'verification_failed');
     return d.revision;
   }))),
   new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('POOL_STARVATION')),1400)),
 ]);
 assert.deepEqual(completed,[1,1]);
});
