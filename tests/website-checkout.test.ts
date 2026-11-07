import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProdamusShortLink,prepareWebsiteProdamusCheckout
} from '../packages/billing/src/website-checkout.ts';
import type {PgBillingStore,OrderRecord} from '../packages/billing/src/store.ts';
import {buildProdamusLinkRequest} from '../packages/billing/src/prodamus.ts';
const id='11111111-1111-4111-8111-111111111111';
const aid='11111111-1111-4111-8111-111111111112';
const pd={formUrl:'https://merchant.payform.ru/',
  notificationUrl:'https://shop.example/webhooks/prodamus',
  successUrl:'https://shop.example/#account',returnUrl:'https://shop.example/#plans',
  secret:'q'.repeat(48)};
test('Prodamus short link is restricted to trusted HTTPS Payform host',()=>{
 assert.equal(validateProdamusShortLink('https://payform.ru/u8zDE/'),
   'https://payform.ru/u8zDE/');
 assert.equal(validateProdamusShortLink('https://merchant.payform.ru/pay/abc'),
   'https://merchant.payform.ru/pay/abc');
 for(const bad of ['http://payform.ru/x','https://fakepayform.ru/x',
  'https://payform.ru.evil.invalid/x','https://payform.ru@evil.invalid/x',
  'https://evil.invalid/x','https://payform.ru/#fragment',
  'https://payform.ru/\nhttps://evil.invalid','<html>not a link</html>']){
  assert.throws(()=>validateProdamusShortLink(bad));
 }
});
test('external website prepares provider link from authenticated account and frozen order',async()=>{
 const order:OrderRecord={id,accountId:aid,product:'vpn',provider:'prodamus',currency:'RUB',
  amount:19900,planId:'vpn-30',planTitle:'VPN 30 дней',durationSeconds:2592000,
  dnsQuotaBytes:null,state:'PENDING',expiresAt:new Date('2026-12-01'),telegramUserId:null};
 const calls:string[]=[];
 const db={createWebsiteOrder:async(a:string,p:string,k:string,t?:string)=>{
  calls.push([a,p,k,t].join(':'));return order;
 }} as unknown as PgBillingStore;
 const result=await prepareWebsiteProdamusCheckout(
  {accountId:aid,requestId:'web-invoice-1',planId:'vpn-30',inviteToken:'A'.repeat(16)},
  db,pd,{getLink:async signedUrl=>{
   const u=new URL(signedUrl);
   assert.equal(u.searchParams.get('do'),'link');
   assert.equal(u.searchParams.get('order_id'),id);
   assert.equal(u.searchParams.get('products[0][price]'),'199.00');
   assert.equal(u.searchParams.get('urlSuccess'),pd.successUrl);
   assert.equal(u.searchParams.get('urlReturn'),pd.returnUrl);
   return 'https://payform.ru/u8zDE/';
  }});
 assert.equal(result.paymentUrl,'https://payform.ru/u8zDE/');
 assert.equal(result.amountMinor,19900);
 assert.deepEqual(calls,[aid+':vpn-30:web-invoice-1:'+('A'.repeat(16))]);
});

test('merchant and notification endpoints remain fragment-free',()=>{
 const order={id,provider:'prodamus' as const,currency:'RUB' as const,
   amountMinor:6000,state:'PENDING' as const};
 for(const bad of [
   {...pd,formUrl:'https://merchant.payform.ru/#account'},
   {...pd,notificationUrl:'https://shop.example/webhooks/prodamus#account'},
 ]){
   assert.throws(()=>buildProdamusLinkRequest(order,'VPN 15 days',bad),
     /HTTPS URL required/);
 }
 assert.doesNotThrow(()=>buildProdamusLinkRequest(order,'VPN 15 days',pd));
});
