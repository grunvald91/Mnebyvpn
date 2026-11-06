import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {PgOutboxDispatcher,type AdapterMap} from '../../packages/provisioning/src/pg-worker.ts';
import type {DesiredAccess,ObservedAccess} from '../../packages/provisioning/src/reconciler.ts';

const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:8});
const db=new PgBillingStore(pool);
before(async()=>{
  await pool.query("UPDATE reconcile_outbox SET handled_at=clock_timestamp() WHERE handled_at IS NULL");
  await pool.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
});
after(async()=>{await pool.end();});
test('24h free trial starts at observed provisioning, not when reserved',async()=>{
 const actor=919818001;
 const created=await db.grantTrial(actor,'vpn');
 assert.equal(created.status,'GRANTED');
 assert.equal(created.expiresAt,undefined,'must not promise a deadline before node activation');
 const orderId=created.orderId!;
 let {rows}=await pool.query(
   'SELECT id,state,revision,starts_at,expires_at FROM entitlements WHERE source_order_id=$1',
   [orderId]);
 assert.equal(rows.length,1);
 const entitlementId=rows[0].id;
 assert.equal(rows[0].state,'PAID_PENDING_PROVISIONING');
 assert.equal(rows[0].starts_at,null);
 assert.equal(rows[0].expires_at,null);
 const noExpiryAdapter:AdapterMap={vpn:{
   inspect:async()=>({revision:0,enabled:false}),
   apply:async()=>{throw new Error('must not provision without hard expiry');},
 }};
 const blocked=new PgOutboxDispatcher(pool,noExpiryAdapter);
 assert.equal((await blocked.processOnce()).reason,'expiry_enforcement_unverified');
 ({rows}=await pool.query('SELECT activated_at FROM trial_grants WHERE order_id=$1',[orderId]));
 assert.equal(rows[0].activated_at,null);
 const state=new Map<string,ObservedAccess>(),applied:DesiredAccess[]=[];
 const secureAdapter:AdapterMap={vpn:{
   enforcesHardExpiry:true,
   inspect:async(id)=>state.get(id)??{revision:0,enabled:false},
   apply:async(desired)=>{
     applied.push({...desired});
     state.set(desired.entitlementId,{revision:desired.revision,enabled:desired.enabled,
       expiresAt:desired.expiresAt});
     return 'applied';
   },
 }};
 // Worker "network calls" are in-memory mocks, NEVER a real VPN node.
 await pool.query('UPDATE reconcile_outbox SET next_attempt_at=clock_timestamp() WHERE entitlement_id=$1',
   [entitlementId]);
 const worker=new PgOutboxDispatcher(pool,secureAdapter);
 const first=await worker.processOnce();
 assert.equal(first.status,'synced','phase 1 provisional enable must complete');
 assert.equal(applied.length,1);
 assert.equal(applied[0].trialPendingActivation,true);
 const now=Date.now();
 assert.ok(applied[0].expiresAt instanceof Date);
 assert.ok(applied[0].expiresAt!.getTime()>now);
 assert.ok(applied[0].expiresAt!.getTime()<=now+5*60*1000);
 const grant=await pool.query(
  'SELECT activated_at,access_expires_at FROM trial_grants WHERE order_id=$1',[orderId]);
 assert.ok(grant.rows[0].activated_at instanceof Date);
 assert.equal(grant.rows[0].access_expires_at.getTime()-
   grant.rows[0].activated_at.getTime(),86400000);
 ({rows}=await pool.query(
  'SELECT state,revision,starts_at,expires_at FROM entitlements WHERE id=$1',[entitlementId]));
 assert.equal(rows[0].state,'ACTIVE');
 assert.equal(Number(rows[0].revision),2);
 assert.equal(rows[0].starts_at.getTime(),grant.rows[0].activated_at.getTime());
 assert.equal(rows[0].expires_at.getTime(),grant.rows[0].access_expires_at.getTime());
 assert.equal((await db.pendingOutboxForOrder(orderId)),1,
  'second phase must update node from short deadline to exact 24h expiry');
 const second=await worker.processOnce();
 assert.equal(second.status,'synced');
 assert.equal(applied.length,2);
 assert.equal(applied[1].revision,2);
 assert.equal(applied[1].trialPendingActivation,false);
 assert.equal(applied[1].expiresAt!.getTime(),grant.rows[0].access_expires_at.getTime());
 assert.equal((await db.pendingOutboxForOrder(orderId)),0);
 assert.equal((await db.grantTrial(actor,'vpn')).status,'ALREADY_USED');
 // Simulate wall-clock expiry in DB, run the regular expiry sweep and revoke.
 await pool.query(
   "UPDATE entitlements SET starts_at=clock_timestamp()-interval '25 hours',"+
   " expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[entitlementId]);
 assert.equal(await worker.expireDue(),1);
 assert.equal((await worker.processOnce()).status,'synced');
 assert.equal(applied.at(-1)?.enabled,false);
});
test('two bundle entitlements share activation deadline from first observed enable',async()=>{
 await pool.query("UPDATE trial_offers SET enabled=true,dns_quota_bytes=1073741824 WHERE product='bundle'");
 const order=await db.grantTrial(919818002,'bundle');
 assert.equal(order.status,'GRANTED');
 const {rows}=await pool.query('SELECT id,product FROM entitlements WHERE source_order_id=$1',
   [order.orderId]);
 assert.equal(rows.length,2);
 const observed=new Map<string,ObservedAccess>();
 const mk=()=>({
  enforcesHardExpiry:true as const,
  inspect:async(id:string)=>observed.get(id)??{revision:0,enabled:false},
  apply:async(d:DesiredAccess)=>{
   observed.set(d.entitlementId,{revision:d.revision,enabled:d.enabled,
      expiresAt:d.expiresAt});
   return 'applied' as const;
  },
 });
 const worker=new PgOutboxDispatcher(pool,{vpn:mk(),smart_dns:mk()});
 assert.equal((await worker.processOnce()).status,'synced');
 const current=await pool.query(
   'SELECT product,revision,starts_at,expires_at FROM entitlements WHERE source_order_id=$1',
   [order.orderId]);
 assert.equal(current.rows.length,2);
 assert.ok(current.rows.every(x=>x.starts_at instanceof Date));
 assert.equal(current.rows[0].starts_at.getTime(),current.rows[1].starts_at.getTime());
 assert.equal(current.rows[0].expires_at.getTime(),current.rows[1].expires_at.getTime());
 // Finish all subsequent revision-2 and sibling claims without assuming order.
 for(let i=0;i<5;i++){
   const x=await worker.processOnce();
   if(x.status==='empty')break;
 }
 assert.equal((await db.pendingOutboxForOrder(order.orderId!)),0);
});
