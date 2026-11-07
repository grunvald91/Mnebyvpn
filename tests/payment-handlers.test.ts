import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  handleTelegramUpdate, handleProdamusDelivery, type TelegramApi,
} from '../packages/billing/src/handlers.ts';
import { parseProdamusFormData } from '../packages/billing/src/multipart.ts';
import { starsPayload } from '../packages/billing/src/stars.ts';
import { signProdamus, type Fields, type ProdamusConfig } from '../packages/billing/src/prodamus.ts';
import type { PgBillingStore, OrderRecord, VerifiedCapture } from '../packages/billing/src/store.ts';

const oid = randomUUID(), aid = randomUUID(), now = new Date();
const key = 'x'.repeat(48);
const pd: ProdamusConfig = {
  formUrl:'https://merchant.payform.ru/',
  notificationUrl:'https://site.example/notifications',
  successUrl:'https://site.example/success',
  returnUrl:'https://site.example/return',
  secret:key,
};
function record(provider:'telegram_stars'|'prodamus',state:OrderRecord['state']='PENDING'):OrderRecord {
  return {
    id:oid, accountId:aid, planId:'vpn-test',planTitle:'VPN',
    durationSeconds:3600,dnsQuotaBytes:null,expiresAt:new Date(now.getTime()+3600000),
    amount:provider==='telegram_stars'?37:9900,
    currency:provider==='telegram_stars'?'XTR':'RUB',
    provider,product:'vpn',state,telegramUserId:provider==='telegram_stars'?123456:null,
  };
}
function fakeStore(order: OrderRecord) {
  const captures: VerifiedCapture[] = [];
  const db = {
    order:async(id:string)=>id===oid?order:null,
    plan:async()=>({planId:'vpn-test',title:'VPN',product:'vpn',stars:37,rubMinor:9900,dnsQuotaBytes:null,durationSeconds:3600}),
    plans:async()=>[{planId:'vpn-test',title:'VPN',product:'vpn',stars:37,rubMinor:9900,dnsQuotaBytes:null,durationSeconds:3600}],
    createTelegramOrder:async()=>order,
    settleVerified:async(c:VerifiedCapture)=>{captures.push(c);return 'APPLIED' as const;},
  };
  const calls:{method:string;params:Record<string,unknown>}[]=[];
  const tg:TelegramApi={call:async(method,params)=>{calls.push({method,params});return true;}};
  return {db:db as unknown as PgBillingStore,tg,captures,calls};
}
const config={prodamus:pd,starsPayloadSecret:key};

test('bot home provides persistent reply keyboard and inline navigation without slash commands',async()=>{
  const f=fakeStore(record('telegram_stars'));
  await handleTelegramUpdate({update_id:10,message:{chat:{id:123456,type:'private'},from:{id:123456},text:'/start'}},f.db,f.tg,config);
  assert.deepEqual(f.calls.map(x=>x.method),['sendMessage','sendMessage']);
  const reply=f.calls[0].params.reply_markup as {keyboard:Array<Array<{text:string}>>};
  assert.ok(reply.keyboard.flat().some(x=>x.text.includes('Поделиться')));
  const inline=f.calls[1].params.reply_markup as {inline_keyboard:Array<Array<{callback_data:string}>>};
  assert.ok(inline.inline_keyboard.flat().some(x=>x.callback_data==='nav:plans:vpn'));
});
test('Stars pre-checkout is answered, but not settled',async()=>{
  const f=fakeStore(record('telegram_stars'));
  await handleTelegramUpdate({update_id:11,pre_checkout_query:{
    id:'pq-1',from:{id:123456},invoice_payload:starsPayload(oid,key),currency:'XTR',total_amount:37,
  }},f.db,f.tg,config);
  assert.equal(f.calls[0].method,'answerPreCheckoutQuery');
  assert.equal(f.calls[0].params.ok,true);
  assert.equal(f.captures.length,0);
});
test('Stars successful payment settles only for matching sender and charge',async()=>{
  const f=fakeStore(record('telegram_stars'));
  const payment={invoice_payload:starsPayload(oid,key),currency:'XTR',total_amount:37,telegram_payment_charge_id:'charge1'};
  await handleTelegramUpdate({update_id:12,message:{chat:{id:123456,type:'private'},from:{id:123456},successful_payment:payment}},f.db,f.tg,config);
  assert.equal(f.captures[0].provider,'telegram_stars');
  assert.equal(f.captures[0].providerTransactionId,'charge1');
  assert.equal(f.calls[0].method,'sendMessage');
  const g=fakeStore(record('telegram_stars'));
  await assert.rejects(()=>handleTelegramUpdate({update_id:13,message:{chat:{id:123456,type:'private'},from:{id:999},successful_payment:payment}},g.db,g.tg,config));
  assert.equal(g.captures.length,0);
});
test('signed Prodamus webhook repeat after PAID is eligible for SQL idempotency',async()=>{
  const f=fakeStore(record('prodamus','PAID'));
  const body:Fields={order_id:'capture1',order_num:oid,domain:'merchant.payform.ru',
    sum:'99.00',currency:'rub',attempt:'2',payment_status:'success'};
  const result=await handleProdamusDelivery(body,signProdamus(body,key),f.db,pd);
  assert.equal(result.statusCode,200);
  assert.equal(f.captures[0].providerTransactionId,'capture1');
  assert.equal(f.captures[0].amount,9900);
  assert.equal((await handleProdamusDelivery({...body,sum:'1.00'},signProdamus(body,key),f.db,pd)).statusCode,401);
});
test('multipart decoder handles official nested products syntax and rejects ambiguous inputs',async()=>{
  const form=new FormData();
  form.set('order_num',oid);
  form.set('products[0][name]','VPN');
  form.set('products[0][price]','99.00');
  // Serialize and parse the SAME multipart request boundary.
  const request=new Request('https://example.test',{method:'POST',body:form});
  const raw=new Uint8Array(await request.arrayBuffer());
  const got=await parseProdamusFormData(request.headers.get('content-type')!,raw);
  assert.equal(got.order_num,oid);
  const product=(got.products as Fields[])[0];
  assert.equal(product.price,'99.00');
  const bad=new FormData();
  bad.append('__proto__[admin]','1');
  const bReq=new Request('https://example.test',{method:'POST',body:bad});
  const badRaw = new Uint8Array(await bReq.arrayBuffer());
  await assert.rejects(()=>parseProdamusFormData(bReq.headers.get('content-type')!, badRaw));
});


test('Prodamus ALL events: signed denied and cancelled callbacks return 200 without access',async()=>{
  const f=fakeStore(record('prodamus'));
  const base:Fields={
    order_id:'unsuccessful-99',order_num:oid,domain:'merchant.payform.ru',
    sum:'99.00',payment_status:'order_denied',attempt:'1',
  };
  for(const status of ['order_denied','order_canceled','pending']){
    const event={...base,payment_status:status};
    const outcome=await handleProdamusDelivery(event,signProdamus(event,key),f.db,pd);
    assert.equal(outcome.statusCode,200);
    assert.equal(outcome.text,'EVENT_ACCEPTED_NO_PAYMENT');
  }
  assert.equal(f.captures.length,0);
  const wrongCurrency={...base,currency:'usd',payment_status:'success'};
  assert.equal((await handleProdamusDelivery(wrongCurrency,signProdamus(wrongCurrency,key),f.db,pd)).statusCode,400);
  const invalid={...base,domain:'other.payform.ru'};
  assert.equal((await handleProdamusDelivery(invalid,signProdamus(invalid,key),f.db,pd)).statusCode,400);
  assert.equal((await handleProdamusDelivery(base,'0'.repeat(64),f.db,pd)).statusCode,401);
  const truncated={...base,payment_status:''};
  assert.equal((await handleProdamusDelivery(truncated,signProdamus(truncated,key),f.db,pd)).statusCode,400);
  assert.equal(f.captures.length,0);
});


test('Prodamus verified refund revokes only original captured order and retries if DB refuses',async()=>{
 const f=fakeStore(record('prodamus','PAID'));
 const refunds:unknown[]=[];
 (f.db as unknown as {applyVerifiedRefund:(x:unknown)=>Promise<'APPLIED'>}).applyVerifiedRefund=async x=>{
  refunds.push(x);return 'APPLIED';
 };
 const fields:Fields={order_id:'capture1',order_num:oid,domain:'merchant.payform.ru',
  sum:'99.00',currency:'rub',payment_status:'refunded',attempt:'1'};
 const reply=await handleProdamusDelivery(fields,signProdamus(fields,key),f.db,pd);
 assert.equal(reply.statusCode,200);
 assert.equal(reply.text,'REFUND_PROCESSED');
 assert.equal(refunds.length,1);
 assert.deepEqual((refunds[0] as {orderId:string;transactionId:string;amount:number}).orderId,oid);
 assert.equal((refunds[0] as {transactionId:string}).transactionId,'capture1');
 const underpaid={...fields,sum:'49.00'};
 assert.equal((await handleProdamusDelivery(underpaid,signProdamus(underpaid,key),f.db,pd)).statusCode,409);
 assert.equal(refunds.length,1);
 (f.db as unknown as {applyVerifiedRefund:(x:unknown)=>Promise<'APPLIED'>}).applyVerifiedRefund=async()=>{
  throw new Error('failed to revoke');
 };
 await assert.rejects(()=>handleProdamusDelivery(fields,signProdamus(fields,key),f.db,pd));
});

test('Prodamus capture never acknowledges a failed database settlement',async()=>{
 const f=fakeStore(record('prodamus'));
 (f.db as unknown as {settleVerified:()=>Promise<string>}).settleVerified=async()=> 'DENY_MISMATCH';
 const fields:Fields={order_id:'capture1',order_num:oid,domain:'merchant.payform.ru',
  sum:'99.00',currency:'rub',payment_status:'success',attempt:'1'};
 const r=await handleProdamusDelivery(fields,signProdamus(fields,key),f.db,pd);
 assert.equal(r.statusCode,503);
 assert.equal(r.text,'SETTLEMENT_NOT_CONFIRMED');
});
