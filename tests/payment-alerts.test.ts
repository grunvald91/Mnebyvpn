import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverPaymentIncidentAlerts} from '../packages/billing/src/payment-alerts.ts';
test('authenticated mismatch produces operational alert without exposing secrets',async()=>{
 const notified:string[]=[];
 const db={
  pendingPaymentIncidentAlerts:async()=>[{id:1,provider:'telegram_stars',
   reason:'STARS_CAPTURE_MISMATCH',amount:32,currency:'XTR'}],
  markPaymentIncidentAlerted:async(id:number)=>{notified.push('done:'+id);},
 };
 const result=await deliverPaymentIncidentAlerts(db,{sendMessage:async(chat,text)=>{
  assert.equal(chat,12345);
  assert.doesNotMatch(text,/bot[0-9]+:/);
  assert.match(text,/ручная проверка/);
  notified.push('send');
 }},12345);
 assert.equal(result,1);
 assert.deepEqual(notified,['send','done:1']);
});
test('failed operator alert stays pending for retry',async()=>{
 let marked=0;
 const db={pendingPaymentIncidentAlerts:async()=>[
  {id:2,provider:'prodamus',reason:'PRODAMUS_CAPTURE_MISMATCH',amount:null,currency:'RUB'}],
  markPaymentIncidentAlerted:async()=>{marked++;}};
 await assert.rejects(()=>deliverPaymentIncidentAlerts(db,{
  sendMessage:async()=>{throw new Error('NET_DOWN')},
 },123),/NET_DOWN/);
 assert.equal(marked,0);
});
