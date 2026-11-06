import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { Script } from 'node:vm';
import {
  vpnWidgetHtml,vpnWidgetPayload,statusWidgetData,plansWidgetData,validateWidgetData,planWidgetKey,
} from '../packages/telegram-ui/src/widget-104.ts';
import { handleTelegramUpdate,type TelegramApi } from '../packages/billing/src/handlers.ts';
import type { PgBillingStore,OrderRecord } from '../packages/billing/src/store.ts';

const now=new Date('2026-11-06T12:00:00.000Z');
const plan={planId:'vpn-1',title:'VPN на месяц',product:'vpn' as const,
  stars:42,rubMinor:9900,durationSeconds:2592000,dnsQuotaBytes:null};
const order:OrderRecord={
  id:'11111111-1111-4111-8111-111111111111', accountId:'11111111-1111-4111-8111-111111111112',
  provider:'telegram_stars',currency:'XTR',amount:42,product:'vpn',
  planId:plan.planId,planTitle:plan.title,durationSeconds:2592000,
  dnsQuotaBytes:null,state:'PENDING',expiresAt:new Date(now.getTime()+3600000),telegramUserId:445566,
};
const pkg={product:'smart_dns' as const,state:'ACTIVE',expiresAt:new Date('2026-12-06T12:00:00Z'),
  quotaLimitBytes:10n*1024n*1024n*1024n,
  quotaUsedBytes:2n*1024n*1024n*1024n};
const secret='s'.repeat(48);
const config={starsPayloadSecret:secret,prodamus:{
  formUrl:'https://merchant.payform.ru/',
  notificationUrl:'https://store.example/notify',successUrl:'https://store.example/ok',
  returnUrl:'https://store.example/back',secret,
}};
function fakeStore() {
  const traces:string[]=[];
  const db={
    listUserPackages:async(id:number)=>{traces.push('packages:'+id);return [pkg];},
    trialProducts:async()=>[],
    plans:async(provider:string)=>{traces.push('plans:'+provider);return [plan];},
    plan:async(id:string)=>id===plan.planId?plan:null,
    reserveStarsInvoice:async()=>true,
    finishStarsInvoice:async()=>{},
    createTelegramOrder:async(id:number,planId:string,requestKey:string)=>{
      traces.push('order:'+id+':'+planId+':'+requestKey);
      return order;
    },
  } as unknown as PgBillingStore;
  const calls:{method:string;params:Record<string,unknown>}[]=[];
  const tg:TelegramApi={call:async(method,params)=>{calls.push({method,params});return true;}};
  return {db,tg,calls,traces};
}
test('10.4 HTML widget fits UTF-8 and zlib limits and uses TelegramWidget SDK',()=>{
  const html=vpnWidgetHtml();
  assert.ok(Buffer.byteLength(html,'utf8')<=32768);
  assert.ok(deflateSync(Buffer.from(html),{level:9}).length<=3800);
  assert.match(html,/TelegramWidget/);
  assert.match(html,/chatDataChanged/);
  assert.match(html,/TW\.request\(data\)/);
  assert.match(html,/type="button"/);
  assert.doesNotMatch(html,/XMLHttpRequest|fetch\(|localStorage|<iframe/);
});
test('personal state is in non-forwardable chat_data, not immutable html or public_data',()=>{
  const state=statusWidgetData([pkg],now);
  validateWidgetData(state);
  const p=vpnWidgetPayload(445566,state);
  assert.equal(p.chat_id,445566);
  assert.equal(p.allow_queries,true);
  assert.equal('is_shared' in p,false);
  assert.equal('public_data' in p,false);
  assert.equal(Buffer.byteLength(p.chat_data,'utf8')<=1024,true);
  assert.equal(p.html.includes('8.00 ГБ'),false);
  const parsed=JSON.parse(state);
  assert.match(parsed.c[0].d,/8\.00 ГБ/);
  assert.equal(parsed.c[0].p,20);
  assert.equal(parsed.k,'status');
});
test('XSS strings remain serialized data and never become executable static HTML',()=>{
  const state=plansWidgetData([{planId:'vpn',title:'<img src=x onerror=alert(1)>',stars:12}],now);
  assert.ok(state.includes('<img'));
  assert.ok(!vpnWidgetHtml().includes('<img src=x'));
  assert.equal(JSON.parse(state).c[0].buy,true);
  assert.throws(()=>validateWidgetData('x'.repeat(1025)));
  assert.throws(()=>vpnWidgetPayload(0,state));
});
test('reply-keyboard status and catalog actions render widget and inline categories',async()=>{
  const f=fakeStore();
  await handleTelegramUpdate({update_id:100,message:{
    chat:{id:445566,type:'private'},from:{id:445566},text:'🔐 Мои подписки',
  }},f.db,f.tg,config);
  await handleTelegramUpdate({update_id:101,message:{
    chat:{id:445566,type:'private'},from:{id:445566},text:'🌐 Выбрать доступ',
  }},f.db,f.tg,config);
  assert.deepEqual(f.calls.map(x=>x.method),['sendWidget','sendMessage']);
  const p=f.calls[0].params;
  assert.equal(p.chat_id,445566);
  assert.equal(p.allow_queries,true);
  assert.equal(JSON.parse(String(p.chat_data)).k,'status');
  const markup=f.calls[1].params.reply_markup as {inline_keyboard:Array<Array<{callback_data:string}>>};
  assert.ok(markup.inline_keyboard.flat().some(x=>x.callback_data==='nav:plans:vpn'));
});
test('10.4 widget_query updates original message chat_data then answers the press',async()=>{
  const f=fakeStore();
  await handleTelegramUpdate({update_id:104,widget_query:{
    id:'q-1',from:{id:445566},chat:{id:445566,type:'private'},
    message_id:123,data:'view:status',
  }},f.db,f.tg,config);
  assert.deepEqual(f.calls.map(x=>x.method),['editMessageWidgetData','answerWidgetQuery']);
  assert.equal(f.calls[0].params.chat_id,445566);
  assert.equal(f.calls[0].params.message_id,123);
  assert.equal(f.calls[1].params.widget_query_id,'q-1');
  assert.equal(JSON.parse(String(f.calls[1].params.data)).k,'status');
  assert.equal(f.calls[0].params.chat_data,f.calls[1].params.data);
});
test('10.4 widget_query Stars purchase uses server-side published plan and invoice',async()=>{
  const f=fakeStore();
  await handleTelegramUpdate({update_id:105,widget_query:{
    id:'q-buy-1',from:{id:445566},chat:{id:445566,type:'private'},
    message_id:123,data:'buy:'+planWidgetKey(plan),
  }},f.db,f.tg,config);
  assert.deepEqual(f.calls.map(x=>x.method),['sendInvoice','answerWidgetQuery']);
  assert.equal(f.calls[0].params.chat_id,445566);
  assert.equal(f.calls[0].params.currency,'XTR');
  assert.equal((f.calls[0].params.prices as Array<{amount:number}>)[0].amount,42);
  assert.equal(f.calls[1].params.data,'INVOICE_SENT');
  assert.ok(f.traces.some(x=>x.includes('widget-query:q-buy-1')));
});
test('widget_query from another chat or forwarded shared copy never accesses private account',async()=>{
  const f=fakeStore();
  await handleTelegramUpdate({update_id:106,widget_query:{
    id:'cross',from:{id:445566},chat:{id:999999,type:'private'},
    message_id:123,data:'view:status',
  }},f.db,f.tg,config);
  await handleTelegramUpdate({update_id:107,shared_widget_query:{
    id:'forward',from:{id:445566},data:'buy:0',widget_id:'99',
  }},f.db,f.tg,config);
  assert.deepEqual(f.calls.map(x=>x.method),['answerWidgetQuery','answerWidgetQuery']);
  assert.deepEqual(f.calls.map(x=>x.params.data),['NOT_ALLOWED','NOT_ALLOWED']);
  assert.deepEqual(f.traces,[]);
});

test('private widget inline script compiles in sandbox JavaScript',()=>{
 const html=vpnWidgetHtml();
 const scriptStart=html.indexOf('<script>')+8,scriptEnd=html.indexOf('</script>');
 assert.ok(scriptStart>=8 && scriptEnd>scriptStart);
 const code=html.slice(scriptStart,scriptEnd);

 assert.doesNotThrow(()=>new Script(code));
});
test('plan button key changes when price, name or duration changes',()=>{
 const original=planWidgetKey(plan);
 assert.equal(original.length,16);
 assert.notEqual(original,planWidgetKey({...plan,stars:(plan.stars??0)+1}));
 assert.notEqual(original,planWidgetKey({...plan,title:'Новый тариф'}));
 assert.notEqual(original,planWidgetKey({...plan,durationSeconds:plan.durationSeconds+3600}));
});
