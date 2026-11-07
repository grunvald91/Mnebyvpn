import test from 'node:test';
import assert from 'node:assert/strict';
import {vpnWorkerCycle,runVpnWorker,notificationBotToken} from '../apps/service/src/vpn-provisioning-worker.ts';
import type {VpnDispatcher} from '../apps/service/src/vpn-provisioning-worker.ts';

test('provisioning cycle only claims VPN signals and processes bounded batches',async()=>{
 let calls=0,drift=0;
 const d:VpnDispatcher={
   expireDue:async()=>2,
   scheduleDriftScan:async(limit,products)=>{
     assert.equal(limit,100);
     assert.deepEqual(products,['vpn']);drift++;return 3;
   },
   processOnce:async(products)=>{
     assert.deepEqual(products,['vpn']);
     calls++;
     return calls<=2?{status:'synced'}:
       calls===3?{status:'retry'}:{status:'empty'};
   },
 };
 assert.deepEqual(await vpnWorkerCycle(d,0,10),{
   expired:2,driftQueued:3,synced:2,retry:1,
 });
 assert.equal(calls,4);
 assert.equal(drift,1);
 assert.deepEqual(await vpnWorkerCycle(d,1,10),{
   expired:2,driftQueued:0,synced:0,retry:0,
 });
 assert.equal(drift,1);
 await assert.rejects(vpnWorkerCycle(d,0,0));
});
test('provisioning worker exits after cancellation and does not perform hidden work',async()=>{
 const controller=new AbortController();
 let loops=0;
 const d:VpnDispatcher={
   expireDue:async()=>{loops++;return 0;},
   scheduleDriftScan:async()=>0,
   processOnce:async()=>({status:'empty'}),
 };
 await runVpnWorker(d,controller.signal,async(ms,signal)=>{
   assert.equal(ms,5000);
   assert.equal(signal,controller.signal);
   if(loops>=3)controller.abort();
 });
 assert.equal(loops,3);
});

test('notification sender reuses existing private bot token without requesting a new secret',()=>{
  const original='123456:'+ 'a'.repeat(40);
  const alternate='654321:'+ 'b'.repeat(40);
  assert.equal(notificationBotToken({TELEGRAM_TOKEN_BOT:original}),original);
  assert.equal(notificationBotToken({TELEGRAM_BOT_TOKEN:alternate}),alternate);
  assert.equal(notificationBotToken({TELEGRAM_TOKEN_BOT:original,TELEGRAM_BOT_TOKEN:alternate}),original);
  assert.throws(()=>notificationBotToken({}));
  assert.throws(()=>notificationBotToken({TELEGRAM_TOKEN_BOT:'invalid'}));
});
