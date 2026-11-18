import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProdamusShortLink,prepareWebsiteProdamusCheckout,prepareWebsiteYookassaCheckout
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
  {accountId:aid,email:'buyer@example.com',requestId:'web-invoice-1',planId:'vpn-30',inviteToken:'A'.repeat(16)},
  db,pd,{getLink:async signedUrl=>{
   const u=new URL(signedUrl);
   assert.equal(u.searchParams.get('do'),'link');
   assert.equal(u.searchParams.get('order_id'),id);
   assert.equal(u.searchParams.get('products[0][price]'),'199.00');
   assert.equal(u.searchParams.get('customer_email'),'buyer@example.com');
   const callback=new URL(u.searchParams.get('urlSuccess')!);
   assert.equal(callback.searchParams.get('order'),id);
   assert.equal(callback.searchParams.get('payment'),'returned');
   assert.equal(callback.hash,'#account');
   const returnUrl=new URL(u.searchParams.get('urlReturn')!);
   assert.equal(returnUrl.searchParams.get('payment'),'return');
   assert.equal(returnUrl.searchParams.get('order'),id);
   assert.equal(returnUrl.hash,'#plans');
   return 'https://payform.ru/u8zDE/';
  }});
 assert.equal(result.paymentUrl,'https://payform.ru/u8zDE/');
 assert.equal(result.amountMinor,19900);
 assert.deepEqual(calls,[aid+':vpn-30:web-invoice-1:'+('A'.repeat(16))]);
});

test('payment data never accepts malformed email or open success redirect',()=>{
  const order={id,provider:'prodamus' as const,currency:'RUB' as const,
    amountMinor:6000,state:'PENDING' as const};
  assert.throws(()=>buildProdamusLinkRequest(order,'VPN',pd,'not-an-email'),/Invalid verified customer email/);
  const params=new URL(buildProdamusLinkRequest(order,'VPN',pd)).searchParams;
  assert.equal(params.has('customer_email'),false);
  assert.equal(new URL(params.get('urlSuccess')!).searchParams.get('order'),id);
  assert.equal(new URL(params.get('urlReturn')!).searchParams.get('order'),id);
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

test('website YooKassa checkout prepares payment with verified email and binds paymentId to order', async () => {
  const order: OrderRecord = {
    id, accountId: aid, product: 'bundle', provider: 'yookassa', currency: 'RUB',
    amount: 39900, planId: 'bundle_30d_3device', planTitle: 'Экосистема «3 в 1» · 30 дней',
    durationSeconds: 30 * 86400, dnsQuotaBytes: null, dnsQuotaQueriesPer30d: 1000000n,
    state: 'PENDING', expiresAt: new Date('2026-12-01'), telegramUserId: null,
  };
  let recorded: [string, string] | null = null;
  const db = {
    createWebsiteOrder: async () => order,
    recordYookassaPayment: async (oId: string, pId: string) => { recorded = [oId, pId]; },
    yookassaPaymentIdForOrder: async () => null,
  };
  const paymentId = '2d8a1f00-000f-5000-8000-999999999999';
  const res = await prepareWebsiteYookassaCheckout(
    { accountId: aid, email: 'buyer@example.com', planId: 'bundle_30d_3device', requestId: 'req-yk-1' },
    db,
    { shopId: '123456', secretKey: 'secret_key_for_test_yookassa', returnUrl: 'https://mnebyvpn.site/payment/return' },
    {
      createPayment: async (_idem, body) => {
        assert.deepEqual(body.amount, { value: '399.00', currency: 'RUB' });
        return {
          id: paymentId,
          status: 'pending',
          paid: false,
          amount: { value: '399.00', currency: 'RUB' },
          confirmation: { type: 'redirect', confirmation_url: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=1' },
          metadata: { order_id: id },
        };
      },
      getPayment: async () => ({}),
      getRefund: async () => ({}),
    },
  );
  assert.equal(res.paymentId, paymentId);
  assert.deepEqual(recorded, [id, paymentId]);
  assert.match(res.paymentUrl, /^https:\/\/yoomoney\.ru\//);
});
