import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { Script, createContext } from 'node:vm';
import {MENU} from '../packages/telegram-ui/src/menu.ts';
import {referralPublicData,referralWidgetHtml,referralWidgetPayload} from '../packages/telegram-ui/src/referral-widget.ts';
import {handleTelegramUpdate,type TelegramApi} from '../packages/billing/src/handlers.ts';
import {pricedPlanForOrder,type PgBillingStore,type OrderRecord} from '../packages/billing/src/store.ts';
import {buildStarsInvoice,type StarsOrder} from '../packages/billing/src/stars.ts';

const token='G6D4qU7Sxw3_A9pB',chatId=546789;
const offer={
 planId:'vpn-30',title:'VPN на 30 дней',product:'vpn' as const,
 stars:150,rubMinor:19900,durationSeconds:30*86400,dnsQuotaBytes:null,
 trialAvailable:true,token,
};
const plan={planId:offer.planId,title:offer.title,product:offer.product,stars:150,
 rubMinor:19900,durationSeconds:30*86400,dnsQuotaBytes:null};
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
 successUrl:'https://merchant.example/yes',returnUrl:'https://merchant.example/return',secret:'n'.repeat(48)}};
function fake(){
 const trace:string[]=[],calls:{method:string;params:Record<string,unknown>}[]=[];
 const db={
  referralOffers:async(id:number)=>{trace.push('owner:'+id);return [offer];},
  referralPlan:async(id:string)=>{trace.push('invite:'+id);return id===token?plan:null;},
  createTelegramOrder:async(id:number,pid:string,key:string,invite?:string)=>{
   trace.push('order:'+id+':'+pid+':'+key+':'+invite);return record;
  },
  grantTrial:async(id:number,product:string,invite?:string)=>{
   trace.push('trial:'+id+':'+product+':'+invite);return {status:'GRANTED' as const};
  },
  trialProducts:async()=>['vpn'],
 } as unknown as PgBillingStore;
 const tg:TelegramApi={call:async(method,params)=>{calls.push({method,params});return true;}};
 return {db,tg,trace,calls};
}
test('public referral HTML is a fixed, sandboxed 10.4 widget within size limits',()=>{
 const html=referralWidgetHtml();
 assert.ok(Buffer.byteLength(html,'utf8')<=32768);
 assert.ok(deflateSync(Buffer.from(html),{level:9}).length<=3800);
 assert.match(html,/TelegramWidget/);
 assert.match(html,/publicData/);
 assert.match(html,/openTelegramLink/);
 assert.doesNotMatch(html,/fetch\(|XMLHttpRequest|chatData|localStorage/);
});
test('forwardable card includes 15/30/60/90-day VPN and DNS terms and RUB/Stars prices',()=>{
 const terms=[15,30,60,90];
 const offers=([0,1] as const).flatMap((p)=>terms.map((d,j)=>({
  ...offer,product:p===0?'vpn' as const:'smart_dns' as const,
  token:('A'.repeat(14)+(p*4+j).toString().padStart(2,'0')),
  title:(p===0?'VPN':'Smart DNS')+' '+d+' дней',
  planId:(p===0?'vpn':'dns')+'-'+d,durationSeconds:d*86400,
  dnsQuotaBytes:p===0?null:10n*1024n*1024n*1024n,
 })));
 const card=referralWidgetPayload(chatId,offers,'MnebyvpnTestBot');
 assert.equal('chat_data' in card,false);
 assert.equal('is_shared' in card,false);
 assert.equal('allow_queries' in card,false);
 assert.ok(Buffer.byteLength(card.public_data,'utf8')<=1024);
 const state=JSON.parse(card.public_data);
 assert.equal(state.v,2);
 assert.equal(state.o.length,8);
 assert.deepEqual(state.o.filter((o:number[])=>o[0]===0).map((o:number[])=>o[1]),terms);
 assert.deepEqual(state.o.filter((o:number[])=>o[0]===1).map((o:number[])=>o[1]),terms);
 assert.equal(state.o[1][2],150);
 assert.equal(state.o[1][3],19900);
 assert.equal(state.o[1][6],1);
 assert.doesNotMatch(card.html,/199,00|G6D4qU7Sxw3_A9pB|MnebyvpnTestBot/);
 assert.throws(()=>referralPublicData(offers,'invalid_bot_name'));
 assert.throws(()=>referralPublicData([{...offer,durationSeconds:undefined as unknown as number}],'MnebyvpnTestBot'),/Invalid public offer/);
});
test('share reply button sends forwardable widget, no slash command required',async()=>{
 const f=fake();
 await handleTelegramUpdate({update_id:13,message:{
  chat:{id:chatId,type:'private'},from:{id:chatId},text:MENU.share,
 }},f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(x=>x.method),['sendWidget','sendMessage']);
 assert.equal(f.calls[0].params.chat_id,chatId);
 assert.ok('public_data' in f.calls[0].params);
 assert.ok(!('chat_data' in f.calls[0].params));
 assert.deepEqual(f.trace,['owner:'+chatId]);
});
test('referral deep link directly sends the chosen invoice without a second menu',async()=>{
 const f=fake();
 await handleTelegramUpdate({update_id:14,message:{
  chat:{id:chatId,type:'private'},from:{id:chatId},text:'/start r'+token,
 }},f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(x=>x.method),['sendInvoice']);
 assert.equal(f.calls[0].params.currency,'XTR');
 assert.equal((f.calls[0].params.prices as Array<{amount:number}>)[0].amount,150);
 assert.deepEqual(f.trace,['invite:'+token,'order:'+chatId+':vpn-30:referral-start:14:'+token]);
});
test('trial deep link grants one-day access without a payment invoice',async()=>{
 const f=fake();
 await handleTelegramUpdate({update_id:17,message:{
  chat:{id:chatId,type:'private'},from:{id:chatId},text:'/start t'+token,
 }},f.db,f.tg,cfg);
 assert.deepEqual(f.calls.map(x=>x.method),['sendMessage']);
 assert.ok(f.trace.includes('trial:'+chatId+':vpn:'+token));
});
test('invoice uses immutable order conditions even when live plan price changes',()=>{
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
test('unknown or expired referral does not open invoice',async()=>{
 const f=fake();
 await handleTelegramUpdate({update_id:15,message:{
  chat:{id:chatId,type:'private'},from:{id:chatId},text:'/start rAAAAAAAAAAAAAAAA',
 }},f.db,f.tg,cfg);
 assert.equal(f.calls[0].method,'sendMessage');
 assert.equal(f.calls.some(x=>x.method==='sendInvoice'),false);
});
function execBubble(data:string){
 const code=referralWidgetHtml().split('<script>')[1].split('</script>')[0];
 const clicked:Array<{label:string;fire:()=>void}>=[];
 const elements=new Map<string,any>();
 function mk(tag:string):any{
  return {
   tag,className:'',textContent:'',hidden:false,children:[] as any[],
   appendChild(child:any){this.children.push(child);return child;},
   insertBefore(child:any,_before:any){this.children.unshift(child);return child;},
   setAttribute(){},
   addEventListener(_ev:string,fire:()=>void){
    clicked.push({label:this.textContent,fire});
   },
  };
 }
 const document={
  getElementById(id:string){if(!elements.has(id))elements.set(id,mk('div'));return elements.get(id);},
  createElement:mk,
 };
 const opens:string[]=[];
 const tg={publicData:data,openTelegramLink:(url:string)=>opens.push(url),ready:()=>{}};
 new Script(code).runInContext(createContext({document,TelegramWidget:tg}));
 return {clicked,opens,elements};
}
test('forwarded widget renders amounts, trial, and opens exact selected paid or trial link',()=>{
 const view=execBubble(referralPublicData([offer],'MnebyvpnTestBot'));
 assert.ok(view.clicked.some(x=>x.label==='🌐 VPN'));
 view.clicked.find(x=>x.label==='Оплатить ⭐')?.fire();
 assert.deepEqual(view.opens,['https://t.me/MnebyvpnTestBot?start=r'+token]);
 view.clicked.find(x=>x.label==='Попробовать')?.fire();
 assert.equal(view.opens[1],'https://t.me/MnebyvpnTestBot?start=t'+token);
});
test('malicious forwarded data cannot open arbitrary external links',()=>{
 const data=JSON.stringify({v:2,b:'EvilBot',o:[[0,30,1,1,'https://evil.example/','Foo',0,0]],more:0});
 const view=execBubble(data);
 view.clicked.find(x=>x.label==='Оплатить ⭐')?.fire();
 assert.deepEqual(view.opens,[]);
});
