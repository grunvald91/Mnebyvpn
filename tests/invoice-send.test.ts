import test from 'node:test';
import assert from 'node:assert/strict';
import {sendReservedStarsInvoice} from '../packages/billing/src/bot-navigation.ts';
import type {PgBillingStore,OrderRecord} from '../packages/billing/src/store.ts';
import type {TelegramApi} from '../packages/billing/src/handlers.ts';

const secret='a'.repeat(48);
function order():OrderRecord {
 return {id:'11111111-1111-4111-8111-111111111111',
  accountId:'11111111-1111-4111-8111-111111111112',
  provider:'telegram_stars',currency:'XTR',product:'vpn',planId:'vpn-30',
  planTitle:'VPN на 30 дней',durationSeconds:30*86400,
  dnsQuotaBytes:null,amount:120,state:'PENDING',
  telegramUserId:12345,expiresAt:new Date(Date.now()+3600000)};
}
function fixture(reject=false){
 let reserved=false;
 const statuses:string[]=[];
 const methods:string[]=[];
 const db={
  reserveStarsInvoice:async()=>{if(reserved)return false;reserved=true;return true;},
  finishStarsInvoice:async(_id:string,state:string)=>{statuses.push(state);},
 } as unknown as PgBillingStore;
 const tg:TelegramApi={call:async(method,params)=>{
  methods.push(method);
  if(method==='sendInvoice'&&reject)throw new Error('AMBIGUOUS_NETWORK_FAILURE');
  assert.equal(params.chat_id,12345);
  assert.equal((params.prices as Array<{amount:number}>)[0].amount,120);
  return true;
 }};
 return {db,tg,methods,statuses};
}
test('same order never sends more than one Stars invoice even if Telegram update is replayed',async()=>{
 const f=fixture();
 assert.equal(await sendReservedStarsInvoice(order(),f.db,f.tg,secret),'SENT');
 assert.equal(await sendReservedStarsInvoice(order(),f.db,f.tg,secret),'ALREADY_REQUESTED');
 assert.deepEqual(f.methods,['sendInvoice']);
 assert.deepEqual(f.statuses,['SENT']);
});
test('ambiguous sendInvoice result is terminal UNKNOWN, no silent retry',async()=>{
 const f=fixture(true);
 await assert.rejects(()=>sendReservedStarsInvoice(order(),f.db,f.tg,secret),
  /AMBIGUOUS_NETWORK_FAILURE/);
 assert.equal(await sendReservedStarsInvoice(order(),f.db,f.tg,secret),'ALREADY_REQUESTED');
 assert.deepEqual(f.statuses,['UNKNOWN']);
 assert.deepEqual(f.methods,['sendInvoice']);
});
