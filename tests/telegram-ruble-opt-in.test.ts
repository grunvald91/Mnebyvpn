import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rublePlanKey} from '../packages/billing/src/offer-keys.ts';
import {issueTelegramRubleLink} from '../packages/billing/src/bot-navigation.ts';
import type {PgBillingStore,OrderRecord} from '../packages/billing/src/store.ts';
import {referralPublicData} from '../packages/telegram-ui/src/referral-widget.ts';
const plan={planId:'vpn-rub-15',title:'VPN 15 дней',product:'vpn' as const,
  durationSeconds:15*86400,dnsQuotaBytes:null,stars:20,rubMinor:19000};
const order:OrderRecord={id:randomUUID(),accountId:randomUUID(),provider:'prodamus',
 currency:'RUB',amount:19000,product:'vpn',planId:plan.planId,planTitle:plan.title,
 durationSeconds:plan.durationSeconds,dnsQuotaBytes:null,state:'PENDING',
 expiresAt:new Date(Date.now()+3600000),telegramUserId:450001};
const pd={formUrl:'https://merchant.payform.ru/',
 notificationUrl:'https://website.example/notify',successUrl:'https://website.example/success',
 returnUrl:'https://website.example/return',secret:'s'.repeat(48)};
test('RUB fingerprint binds the actual amount independently of Stars',()=>{
 assert.notEqual(rublePlanKey(plan),rublePlanKey({...plan,rubMinor:20000}));
 assert.notEqual(rublePlanKey(plan),rublePlanKey({...plan,durationSeconds:30*86400}));
});
test('explicitly opted-in Telegram ruble link goes directly to checked Payform',async()=>{
 const calls:{method:string;params:Record<string,unknown>}[]=[];
 const keys:string[]=[];
 const db={
  plans:async()=>[plan],createTelegramRubleOrder:async(...args:string[])=>{
    keys.push(args.join(':'));return order;
  },
 } as unknown as PgBillingStore;
 const status=await issueTelegramRubleLink(450001,rublePlanKey(plan),'click-1',
  db,{call:async(method,params)=>{calls.push({method,params});return true;}},
  {starsPayloadSecret:'x'.repeat(48),prodamus:pd,
   prodamusTelegramLink:{getLink:async(request)=>{
    const u=new URL(request);
    assert.equal(u.hostname,'merchant.payform.ru');
    assert.equal(u.searchParams.get('do'),'link');
    assert.equal(u.searchParams.get('order_id'),order.id);
    return 'https://payform.ru/u8zDE/';
   }},
  });
 assert.equal(status,'SENT');
 assert.equal(calls[0].method,'sendMessage');
 const markup=calls[0].params.reply_markup as {
  inline_keyboard:Array<Array<{text:string;url:string}>>};
 assert.equal(markup.inline_keyboard[0][0].url,'https://payform.ru/u8zDE/');
 assert.ok(keys[0].includes(rublePlanKey(plan)));
});
test('without explicit opt-in Telegram ruble checkout is unavailable',async()=>{
 const db={} as PgBillingStore;
 const tg={call:async()=>{throw new Error('MUST_NOT_CALL_TELEGRAM')}};
 assert.equal(await issueTelegramRubleLink(450001,rublePlanKey(plan),'request',db,tg,
  {starsPayloadSecret:'x'.repeat(48)}),'DISABLED');
});
test('forwarded referral widget only exposes RUB checkout deep-link when explicitly enabled',()=>{
 const offer={...plan,token:'ABCDEFGHIJKLMNOP'};
 const x=JSON.parse(referralPublicData([offer],'MnebyvpnTestBot',false));
 const y=JSON.parse(referralPublicData([offer],'MnebyvpnTestBot',true));
 assert.equal(x.r,0);assert.equal(y.r,1);
});
