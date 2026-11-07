import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {PgOutboxDispatcher} from '../../packages/provisioning/src/pg-worker.ts';
import {OfflineExpiryNodeSimulator} from '../../packages/provisioning/src/offline-expiry-simulator.ts';

const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
 user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
 database:process.env.PGDATABASE??'mnebyvpn_test',max:8});
const store=new PgBillingStore(pool);
const plan='partition-'+randomUUID().slice(0,8);
before(async()=>{
 await pool.query("UPDATE reconcile_outbox SET handled_at=clock_timestamp() WHERE handled_at IS NULL");
 await pool.query('INSERT INTO billing_plans(id,product,title,duration_seconds,stars,enabled) VALUES($1,$2,$3,$4,$5,true)',
  [plan,'vpn','Partition offline test',3600,41]);
});
after(async()=>pool.end());
test('simulated VPN node enforces deadline for new and existing sessions while disconnected',async()=>{
 const order=await store.createTelegramOrder(94771103,plan,'partition-order');
 assert.equal(await store.settleVerified({
  provider:'telegram_stars',orderId:order.id,providerEventId:'ev:'+order.id,
  providerTransactionId:'txn:'+order.id,payloadHash:'a'.repeat(64),amount:41,currency:'XTR',
 }),'APPLIED');
 const {rows}=await pool.query('SELECT id,starts_at,expires_at FROM entitlements WHERE source_order_id=$1',
  [order.id]);
 assert.equal(rows.length,1);
 let instant=new Date();
 const node=new OfflineExpiryNodeSimulator(()=>instant);
 const worker=new PgOutboxDispatcher(pool,{vpn:node});
 const first=await worker.processOnce();
 assert.equal(first.status,'synced');
 const finalized=await worker.processOnce();
 assert.equal(finalized.status,'synced','paid node must apply the final hard expiry');
 rows[0].expires_at=(await pool.query('SELECT expires_at FROM entitlements WHERE id=$1',[rows[0].id])).rows[0].expires_at;
 const session=node.connect(rows[0].id);
 assert.ok(session);
 assert.equal(node.transfer(session!),true);
 node.setControlLink(false);
 instant=new Date(rows[0].expires_at.getTime()+1);
 assert.equal(node.connect(rows[0].id),null);
 assert.equal(node.transfer(session!),false);
 // Real PostgreSQL wall-time cannot be warped. Simulate the same positive
 // 1-hour interval, but in the past; expiry SQL must generate a disable.
 await pool.query(
  "UPDATE entitlements SET starts_at=clock_timestamp()-interval '2 hours',"+
  " expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[rows[0].id]);
 assert.equal(await worker.expireDue(),1);
 const pending=await worker.processOnce();
 assert.equal(pending.status,'retry');
 assert.equal(node.transfer(session!),false);
 node.setControlLink(true);
 await pool.query("UPDATE reconcile_outbox SET next_attempt_at=clock_timestamp() WHERE entitlement_id=$1",
  [rows[0].id]);
 assert.equal((await worker.processOnce()).status,'synced');
 const post=await pool.query('SELECT state FROM entitlements WHERE id=$1',[rows[0].id]);
 assert.equal(post.rows[0].state,'EXPIRED');
 assert.equal(node.connect(rows[0].id),null);
});
