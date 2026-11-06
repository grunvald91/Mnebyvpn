import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgBillingStore } from '../../packages/billing/src/store.ts';
import { PgOutboxDispatcher, type AdapterMap } from '../../packages/provisioning/src/pg-worker.ts';
import { type DesiredAccess, type ObservedAccess } from '../../packages/provisioning/src/reconciler.ts';
import { handleTelegramUpdate, type TelegramApi } from '../../packages/billing/src/handlers.ts';
import { starsPayload } from '../../packages/billing/src/stars.ts';

const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:8});
const db=new PgBillingStore(pool);
const planId='phase5-'+randomUUID().slice(0,8);
const key='k'.repeat(48);
before(async()=>{
  await pool.query("UPDATE reconcile_outbox SET handled_at=clock_timestamp() WHERE handled_at IS NULL");
  await pool.query(
    `INSERT INTO billing_plans(id,product,title,duration_seconds,stars,rub_minor,enabled)
     VALUES($1,'vpn','Offline test',3600,29,9000,true)`,[planId]);
});
after(async()=>pool.end());
function capture(orderId:string,charge:string) {
  return {provider:'telegram_stars' as const,orderId,providerEventId:charge,
    providerTransactionId:charge,amount:29,currency:'XTR' as const,payloadHash:'a'.repeat(64)};
}
test('worker cannot grant with missing adapter; mock grant then full refund revokes',async()=>{
  const order=await db.createTelegramOrder(771100,planId,'phase5-checkout');
  assert.equal(await db.settleVerified(capture(order.id,'charge-5')),'APPLIED');
  const empty=new PgOutboxDispatcher(pool);
  assert.equal((await empty.processOnce()).reason,'adapter_not_connected');
  let r=await pool.query('SELECT state FROM entitlements WHERE source_order_id=$1',[order.id]);
  assert.equal(r.rows[0].state,'PAID_PENDING_PROVISIONING');

  const observed=new Map<string,ObservedAccess>(),calls:string[]=[];
  const mock:AdapterMap={vpn:{
    enforcesHardExpiry:true,
    inspect:async(id)=>observed.get(id)??{revision:0,enabled:false},
    apply:async(d:DesiredAccess,operationId)=>{
      calls.push(operationId);
      observed.set(d.entitlementId,{revision:d.revision,enabled:d.enabled,expiresAt:d.expiresAt});
      return 'applied';
    },
  }};
  const worker=new PgOutboxDispatcher(pool,mock);
  await pool.query(
    'UPDATE reconcile_outbox SET next_attempt_at=clock_timestamp() WHERE entitlement_id=(SELECT id FROM entitlements WHERE source_order_id=$1)',[order.id]);
  assert.equal((await worker.processOnce()).status,'synced');
  r=await pool.query('SELECT state FROM entitlements WHERE source_order_id=$1',[order.id]);
  assert.equal(r.rows[0].state,'ACTIVE');
  const refund={provider:'telegram_stars' as const,orderId:order.id,transactionId:'charge-5',
    refundEventId:'refund:charge-5',payloadHash:'b'.repeat(64),amount:29,currency:'XTR' as const};
  assert.equal(await db.applyVerifiedRefund(refund),'APPLIED');
  assert.equal(await db.applyVerifiedRefund({...refund,payloadHash:'c'.repeat(64)}),'DUPLICATE_EVENT');
  assert.equal((await worker.processOnce()).status,'synced');
  r=await pool.query('SELECT state,revision FROM entitlements WHERE source_order_id=$1',[order.id]);
  assert.equal(r.rows[0].state,'REFUNDED');
  assert.equal(Number(r.rows[0].revision),2);
  assert.deepEqual(calls.map(x=>x.split(':').slice(-2).join(':')),['1:enable','2:disable']);
});
test('Telegram refunded_payment is idempotent and does not revoke another purchase',async()=>{
  const a=await db.createTelegramOrder(771101,planId,'phase5-2a');
  const b=await db.createTelegramOrder(771101,planId,'phase5-2b');
  await db.settleVerified(capture(a.id,'charge-a'));
  await db.settleVerified(capture(b.id,'charge-b'));
  const sent:string[]=[];
  const tg:TelegramApi={call:async(method)=>{sent.push(method);return true;}};
  const config={starsPayloadSecret:key,prodamus:{
    formUrl:'https://test.payform.ru/',notificationUrl:'https://site.example/notify',
    successUrl:'https://site.example/success',returnUrl:'https://site.example/return',secret:key,
  }};
  const refunded_payment={currency:'XTR',total_amount:29,invoice_payload:starsPayload(a.id,key),
    telegram_payment_charge_id:'charge-a'};
  const update={update_id:501,message:{chat:{id:771101,type:'private'},refunded_payment}};
  await handleTelegramUpdate(update,db,tg,config);
  await handleTelegramUpdate({...update,update_id:502},db,tg,config);
  const {rows}=await pool.query(
    'SELECT id,source_order_id,state,revision FROM entitlements WHERE account_id=$1 AND product=$2',
    [a.accountId,'vpn']);
  assert.equal(rows.length,1,'renewal must keep same VPN entitlement');
  assert.equal(rows[0].source_order_id,a.id);
  assert.equal(rows[0].state,'PAID_PENDING_PROVISIONING');
  assert.equal(Number(rows[0].revision),3);
  const {rows:credits}=await pool.query(
    'SELECT order_id,refunded,entitlement_id FROM order_entitlement_credits WHERE order_id=ANY($1::uuid[])',
    [[a.id,b.id]]);
  assert.equal(credits.length,2);
  assert.equal(new Set(credits.map(x=>x.entitlement_id)).size,1);
  assert.equal(credits.find(x=>x.order_id===a.id)?.refunded,true);
  assert.equal(credits.find(x=>x.order_id===b.id)?.refunded,false);
  assert.deepEqual(sent,['sendMessage']);
  await assert.rejects(()=>handleTelegramUpdate({...update,update_id:503,
    message:{...update.message,refunded_payment:{...refunded_payment,telegram_payment_charge_id:'charge-b'}}},
    db,tg,config));
});
