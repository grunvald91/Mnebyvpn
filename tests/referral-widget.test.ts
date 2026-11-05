import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  referralPublicData,referralWidgetHtml,referralWidgetPayload,
} from '../packages/telegram-ui/src/referral-widget.ts';
import { handleTelegramUpdate,type TelegramApi } from '../packages/billing/src/handlers.ts';
import { pricedPlanForOrder,type PgBillingStore,type OrderRecord } from '../packages/billing/src/store.ts';
import { buildStarsInvoice, type StarsOrder } from '../packages/billing/src/stars.ts';

const token='G6D4qU7Sxw3_A9pB',chatId=546789;
const offer={
  planId:'vpn-30',title:'VPN на 30 дней',product:'vpn' as const,
  stars:150,rubMinor:19900,token,
};
const plan={planId:offer.planId,product:offer.product,title:offer.title,stars:150,
  rubMinor:19900,durationSeconds:2592000,dnsQuotaBytes:null};
const record:OrderRecord={
  id:'11111111-1111-4111-8111-111111111111',
  accountId:'11111111-1111-4111-8111-111111111112',
  provider:'telegram_stars',currency:'XTR',amount:150,
  product:'vpn',planId:plan.planId,planTitle:plan.title,
  durationSeconds:plan.durationSeconds,dnsQuotaBytes:null,
  state:'PENDING',expiresAt:new Date('2026-11-07'),telegramUserId:chatId,
};
const cfg={starsPayloadSecret:'m'.repeat(48),telegramBotUsername:'MnebyvpnTestBot',
  prodamus:{formUrl:'https://merchant.payform.ru/',notificationUrl:'https://merchant.example/notify',
    successUrl:'https://merchant.example/yes',returnUrl:'https://merchant.example/return',
    secret:'n'.repeat(48)}};
function fake(){
 const trace:string[]=[];const calls:{method:string;params:Record<string,unknown>}[]=[];
 const db={
   referralOffers:async(id:number)=>{trace.push('owner:'+id);return [offer];},
   referralPlan:async(id:string)=>{trace.push('invite:'+id);return id===token?plan:null;},
   createTelegramOrder:async(id:number,pid:string,key:string,invite?:string)=>{
     trace.push('order:'+id+':'+pid+':'+key+':'+invite);return record;
   },
 } as unknown as PgBillingStore;
 const tg:TelegramApi={call:async(method,params)=>{calls.push({method,params});return true;}};
 return {db,tg,trace,calls};
}
test('referral HTML has no private state and is within Telegram 10.4 size budget',()=>{
 const html=referralWidgetHtml();
 assert.ok(Buffer.byteLength(html,'utf8')<=32768);
 assert.ok(deflateSync(Buffer.from(html),{level:9}).length<=3800);
 assert.match(html,/TelegramWidget/);
 assert.match(html,/publicData/);
 assert.match(html,/openTelegramLink/);
 assert.doesNotMatch(html,/fetch\(|XMLHttpRequest|chatData|localStorage/);
});
test('public prices and short deep links survive forwarding without personal chat_data',()=>{
 const p=referralWidgetPayload(chatId,[offer],'MnebyvpnTestBot');
 assert.equal('chat_data' in p,false);
 assert.equal('is_shared' in p,false);
 assert.equal('allow_queries' in p,false);
 const data=JSON.parse(p.public_data);
 assert.equal(data.c[0].s,150);
 assert.equal(data.c[0].r,'199,00 ₽');
 assert.equal(data.c[0].u,'https://t.me/MnebyvpnTestBot?start=r'+token);
 assert.doesNotMatch(p.html,/MnebyvpnTestBot|199,00|G6D4qU7Sxw3_A9pB/);
 assert.ok(Buffer.byteLength(p.public_data,'utf8')<=1024);
 assert.throws(()=>referralPublicData([offer],'wrong'));
});
test('share command sends forwardable widget without shared query permissions',async()=>{
 const f=fake();
 await handleTelegramUpdate({update_id:13,message:{chat:{id:chatId,type:'private'},
   from:{id:chatId},text:'/share'}},f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(x=>x.method),['sendWidget']);
 const p=f.calls[0].params;
 assert.equal(p.chat_id,chatId);
 assert.equal('chat_data' in p,false);
 assert.equal('public_data' in p,true);
 assert.equal('allow_queries' in p,false);
 assert.deepEqual(f.trace,['owner:'+chatId]);
});
test('referral start opens preselected Stars invoice and stores attributed checkout',async()=>{
 const f=fake();
 await handleTelegramUpdate({update_id:14,message:{chat:{id:chatId,type:'private'},
   from:{id:chatId},text:'/start r'+token}},f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(x=>x.method),['sendInvoice']);
 assert.equal(f.calls[0].params.currency,'XTR');
 assert.equal((f.calls[0].params.prices as Array<{amount:number}>)[0].amount,150);
 assert.deepEqual(f.trace,['invite:'+token,
   'order:'+chatId+':vpn-30:referral-start:14:'+token]);
});
test('buyer sees immutable purchased price despite catalog change after order creation',()=>{
 const changed={...plan,stars:300,title:'New catalog title'};
 const snapshot=pricedPlanForOrder(record);
 assert.equal(snapshot.stars,150);
 assert.equal(snapshot.title,'VPN на 30 дней');
 assert.notEqual(snapshot.stars,changed.stars);
 const invoice=buildStarsInvoice({
  id:record.id,provider:'telegram_stars',currency:'XTR',accountId:record.accountId,
  telegramUserId:chatId,amount:150,state:'PENDING',expiresAt:record.expiresAt,
 } satisfies StarsOrder,snapshot,cfg.starsPayloadSecret);
 assert.equal(invoice.prices[0].amount,150);
});
test('expired/invalid referral is rejected, never creates order',async()=>{
 const f=fake();
 await handleTelegramUpdate({update_id:15,message:{chat:{id:chatId,type:'private'},
    from:{id:chatId},text:'/start rAAAAAAAAAAAAAAAA'}},f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(x=>x.method),['sendMessage']);
 assert.equal(f.trace.some(x=>x.startsWith('order:')),false);
});
