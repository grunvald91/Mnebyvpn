import test from 'node:test';
import assert from 'node:assert/strict';
import {MENU,formatDuration,formatRoubles} from '../packages/telegram-ui/src/menu.ts';
import {planWidgetKey} from '../packages/telegram-ui/src/widget-104.ts';
import {handleTelegramUpdate,type TelegramApi} from '../packages/billing/src/handlers.ts';
import type {PgBillingStore,OrderRecord} from '../packages/billing/src/store.ts';

const user=773311,planIds=[15,30,60,90];
const plans=planIds.flatMap((days,i)=>[
 {planId:'vpn-'+days,product:'vpn' as const,title:'VPN '+days+' дней',stars:days+5,
  rubMinor:days*100,durationSeconds:days*86400,dnsQuotaBytes:null},
 {planId:'dns-'+days,product:'smart_dns' as const,title:'DNS '+days+' дней',stars:days+2,
  rubMinor:days*50,durationSeconds:days*86400,dnsQuotaBytes:10n*1024n*1024n*1024n},
]);
const cfg={starsPayloadSecret:'z'.repeat(48),telegramBotUsername:'MnebyvpnTestBot',
 prodamus:{formUrl:'https://merchant.payform.ru/',notificationUrl:'https://store.example/hook',
 successUrl:'https://store.example/ok',returnUrl:'https://store.example/return',secret:'z'.repeat(48)}};
function fake(){
 const actions:string[]=[];
 const calls:{method:string;params:Record<string,unknown>}[]=[];
 const db={
  plans:async()=>plans,
  plan:async(id:string)=>plans.find(p=>p.planId===id)??null,
  trialProducts:async()=>['vpn','smart_dns'],
  grantTrial:async(id:number,product:string)=>{actions.push('grant:'+id+':'+product);return {status:'GRANTED'};},
  reserveStarsInvoice:async()=>true,
  finishStarsInvoice:async()=>{},
  createTelegramOrder:async(id:number,planId:string,requestId:string,_token?:string,key?:string)=>{
   actions.push('order:'+id+':'+planId+':'+requestId+':'+key);
   const p=plans.find(x=>x.planId===planId)!;
   return {id:'11111111-1111-4111-8111-111111111111',
    accountId:'11111111-1111-4111-8111-111111111112',
    provider:'telegram_stars',currency:'XTR',amount:p.stars,product:p.product,
    planId:p.planId,planTitle:p.title,durationSeconds:p.durationSeconds,
    dnsQuotaBytes:p.dnsQuotaBytes,state:'PENDING',telegramUserId:id,
    expiresAt:new Date(Date.now()+3600000)} as OrderRecord;
  },
 } as unknown as PgBillingStore;
 const tg:TelegramApi={call:async(method,params)=>{calls.push({method,params});return true;}};
 return {db,tg,actions,calls};
}
function callback(data:string,update_id=100){
 return {update_id,callback_query:{id:'cb-'+update_id,from:{id:user},data,
  message:{chat:{id:user,type:'private'}}}};
}
test('visible durations are truthful fixed terms, RUB displayed independently of Stars',()=>{
 assert.equal(formatDuration(15*86400),'15 дней');
 assert.equal(formatDuration(30*86400),'30 дней');
 assert.match(formatDuration(60*86400),/60 дней/);
 assert.match(formatDuration(90*86400),/90 дней/);
 assert.equal(formatRoubles(19900),'199,00 ₽');
});
test('VPN purchase opens HTML widget with four actual catalogue prices',async()=>{
 const f=fake();
 await handleTelegramUpdate(callback('nav:plans:vpn'),f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(c=>c.method),['answerCallbackQuery','sendWidget']);
 const widget=f.calls[1].params;
 assert.equal(widget.allow_queries,false);
 const state=JSON.parse(String(widget.chat_data));
 assert.deepEqual(state.p.map((p:number[])=>p[0]),[15,30,60,90]);
 assert.deepEqual(state.p.map((p:number[])=>p[1]),[20,35,65,95]);
 assert.deepEqual(state.p.map((p:(number|string)[])=>p[4]),[0,2,4,6].map(i=>planWidgetKey(plans[i])));
 const keyboard=widget.reply_markup as {inline_keyboard:Array<Array<{callback_data:string}>>};
 const buttons=keyboard.inline_keyboard.flat().map(x=>x.callback_data);
 assert.ok(buttons.includes('trial:vpn'));
 assert.ok(buttons.includes('nav:plans:vpn:list'));
});
test('old Telegram clients retain a plain inline tariff list with Stars checkout',async()=>{
 const f=fake();
 await handleTelegramUpdate(callback('nav:plans:vpn:list'),f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(c=>c.method),['answerCallbackQuery','sendMessage']);
 const text=String(f.calls[1].params.text);
 for(const duration of [15,30,60,90])assert.match(text,new RegExp(duration+' дней'));
 const keyboard=f.calls[1].params.reply_markup as {inline_keyboard:Array<Array<{callback_data:string}>>};
 const buttons=keyboard.inline_keyboard.flat().map(x=>x.callback_data);
 assert.ok(buttons.includes('buy:'+planWidgetKey(plans[0])));
 assert.ok(buttons.includes('buy:'+planWidgetKey(plans[6])));
 assert.ok(buttons.includes('nav:catalog'));
});
test('purchase inline button acknowledges immediately, then invoices immutable selected order',async()=>{
 const f=fake();
 const selected=plans[2]; // 30 day VPN
 const hash=planWidgetKey(selected);
 await handleTelegramUpdate(callback('buy:'+hash,101),f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(c=>c.method),['answerCallbackQuery','sendInvoice']);
 assert.equal((f.calls[1].params.prices as Array<{amount:number}>)[0].amount,selected.stars);
 assert.ok(f.actions.some(x=>x.includes('order:'+user+':'+selected.planId+':tg-callback:cb-101:'+hash)));
});
test('stale product/price button never creates an invoice',async()=>{
 const f=fake();
 const invalid='A'.repeat(16);
 await handleTelegramUpdate(callback('buy:'+invalid,102),f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(c=>c.method),['answerCallbackQuery','sendMessage']);
 assert.equal(f.actions.some(x=>x.startsWith('order:')),false);
});
test('trial is accessible from inline button and requests no payment',async()=>{
 const f=fake();
 await handleTelegramUpdate(callback('trial:smart_dns',103),f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(c=>c.method),['answerCallbackQuery','sendMessage']);
 assert.ok(f.actions.includes('grant:'+user+':smart_dns'));
 assert.equal(f.calls.some(c=>c.method==='sendInvoice'),false);
});
test('reply keyboard home has share and trial actions without typed commands',async()=>{
 const f=fake();
 await handleTelegramUpdate({update_id:111,message:{
  from:{id:user},chat:{id:user,type:'private'},text:'/start',
 }},f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(c=>c.method),['sendMessage','sendMessage']);
 const reply=f.calls[0].params.reply_markup as {keyboard:Array<Array<{text:string}>>};
 const buttons=reply.keyboard.flat().map(x=>x.text);
 assert.ok(buttons.includes(MENU.catalog));
 assert.ok(buttons.includes(MENU.share));
 assert.ok(buttons.includes(MENU.trial));
 assert.ok(buttons.includes(MENU.mine));
});
