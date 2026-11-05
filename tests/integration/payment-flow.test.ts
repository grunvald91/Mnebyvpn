import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgBillingStore, starsOrderFromDB, prodamusOrderFromDB } from '../../packages/billing/src/store.ts';
import { starsPayload, validateStarsSuccess } from '../../packages/billing/src/stars.ts';
import { signProdamus } from '../../packages/billing/src/prodamus.ts';
import { handleProdamusDelivery, handleTelegramUpdate, type TelegramApi } from '../../packages/billing/src/handlers.ts';

const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:8});
const store=new PgBillingStore(pool);
const planId='test-'+randomUUID().slice(0,8);
const key='z'.repeat(48);
before(async()=>{
 await pool.query(
  `INSERT INTO billing_plans(id,product,title,duration_seconds,rub_minor,stars,enabled)
   VALUES($1,'vpn','Test VPN',3600,9900,37,true)`,[planId]);
});
after(async()=>{await pool.end();});

test('concurrent requests for same idempotency key create ONE Stars order',async()=>{
 const requests=Array.from({length:8},()=>store.createTelegramOrder(998877,planId,'telegram-key-race'));
 const results=await Promise.all(requests);
 assert.equal(new Set(results.map(x=>x.id)).size,1);
 const record=results[0];
 assert.equal(record.currency,'XTR');
 assert.equal(record.amount,37);
 assert.equal(record.telegramUserId,998877);
 const {rows}=await pool.query('SELECT count(*)::int AS n FROM orders WHERE id=$1',[record.id]);
 assert.equal(rows[0].n,1);
 const pre=validateStarsSuccess({currency:'XTR',total_amount:37,
    invoice_payload:starsPayload(record.id,key),telegram_payment_charge_id:'tg-charge-1'},
    998877,starsOrderFromDB(record),key);
 assert.equal(pre.ok,true);
 if (!pre.ok) return;
 const capture={provider:'telegram_stars' as const,orderId:record.id,
   providerEventId:pre.capture.providerEventId, providerTransactionId:pre.capture.providerTransactionId,
   amount:37,currency:'XTR' as const,payloadHash:'a'.repeat(64)};
 const [one,two]=await Promise.all([store.settleVerified(capture),store.settleVerified(capture)]);
 assert.deepEqual([one,two].sort(),['APPLIED','DUPLICATE_EVENT'].sort());
 assert.equal(await store.pendingOutboxForOrder(record.id),1);
 const {rows:ents}=await pool.query('SELECT count(*)::int AS n FROM entitlements WHERE source_order_id=$1',[record.id]);
 assert.equal(ents[0].n,1);
});
test('Prodamus signed retry after committed payment never creates second entitlement',async()=>{
 const accountId=randomUUID();
 await pool.query('INSERT INTO accounts(id) VALUES($1)',[accountId]);
 const record=await store.createWebsiteOrder(accountId,planId,'external-key-1');
 const config={
   formUrl:'https://merchant.payform.ru/',notificationUrl:'https://example.test/notify',
   successUrl:'https://example.test/success',returnUrl:'https://example.test/return',secret:key};
 const form={order_num:record.id,order_id:'pd-charge-1',domain:'merchant.payform.ru',
   sum:'99.00',payment_status:'success',attempt:'1'};
 const first=await handleProdamusDelivery(form,signProdamus(form,key),store,config);
 assert.equal(first.statusCode,200);
 assert.equal(first.text,'OK');
 const retry={...form,attempt:'2'};
 const second=await handleProdamusDelivery(retry,signProdamus(retry,key),store,config);
 assert.equal(second.statusCode,200);
 assert.equal(second.text,'ALREADY_PROCESSED');
 assert.equal(await store.pendingOutboxForOrder(record.id),1);
 const {rows}=await pool.query('SELECT count(*)::int AS n FROM entitlements WHERE source_order_id=$1',[record.id]);
 assert.equal(rows[0].n,1);
});
test('Stars repeat success after PAID is accepted and handled idempotently',async()=>{
 const record=await store.createTelegramOrder(443322,planId,'telegram-key-repeat');
 const tgCalls:string[]=[];
 const api:TelegramApi={call:async(method)=>{tgCalls.push(method);return true;}};
 const config={prodamus:{
    formUrl:'https://merchant.payform.ru/',notificationUrl:'https://example.test/notify',
    successUrl:'https://example.test/success',returnUrl:'https://example.test/return',secret:key
   },starsPayloadSecret:key};
 const update={update_id:1000,message:{chat:{id:443322,type:'private'},
   from:{id:443322},
   successful_payment:{currency:'XTR',total_amount:37,
     invoice_payload:starsPayload(record.id,key),telegram_payment_charge_id:'tg-charge-repeat'}}};
 await handleTelegramUpdate(update,store,api,config);
 await handleTelegramUpdate({...update,update_id:1001},store,api,config);
 assert.deepEqual(tgCalls,['sendMessage']);
 assert.equal(await store.pendingOutboxForOrder(record.id),1);
});
