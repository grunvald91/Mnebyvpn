import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {prepareWebsiteProdamusCheckout} from '../../packages/billing/src/website-checkout.ts';
import {validateStarsSuccess,starsPayload} from '../../packages/billing/src/stars.ts';
import {verifyProdamusPayment,signProdamus} from '../../packages/billing/src/prodamus.ts';
const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:6});
const db=new PgBillingStore(pool);
const suffix=randomUUID().slice(0,8);
const planId='latepay-'+suffix;
const secret='secret'.repeat(8);
const payform={formUrl:'https://merchant.payform.ru/',
 notificationUrl:'https://shop.example/notifications',successUrl:'https://shop.example/success',
 returnUrl:'https://shop.example/return',secret};
before(async()=>{
 await pool.query('INSERT INTO billing_plans(id,product,title,duration_seconds,rub_minor,stars,enabled) VALUES($1,$2,$3,$4,$5,$6,true)',
  [planId,'vpn','Late confirmed VPN',86400,19900,55]);
});
after(async()=>pool.end());
test('verified Stars capture still settles after internal PENDING cleanup to CANCELLED',async()=>{
 const user=81838300;
 const order=await db.createTelegramOrder(user,planId,'stars-late-'+suffix);
 await pool.query("UPDATE orders SET state='CANCELLED' WHERE id=$1",[order.id]);
 const payment={currency:'XTR',total_amount:55,invoice_payload:starsPayload(order.id,secret),
   telegram_payment_charge_id:'verified-charge-'+suffix};
 const verified=validateStarsSuccess(payment,user,{id:order.id,accountId:order.accountId,
  telegramUserId:user,provider:'telegram_stars',currency:'XTR',amount:55,
  state:'CANCELLED',expiresAt:order.expiresAt},secret);
 assert.equal(verified.ok,true,'genuine captured charge must not disappear due to cleanup');
 if(!verified.ok)throw new Error('unreachable');
 const input={
  provider:'telegram_stars' as const,orderId:order.id,providerEventId:verified.capture.providerEventId,
  providerTransactionId:verified.capture.providerTransactionId,
  currency:'XTR' as const,amount:55,payloadHash:'a'.repeat(64),
 };
 assert.equal(await db.settleVerified(input),'APPLIED');
 assert.equal(await db.settleVerified({...input,payloadHash:'b'.repeat(64)}),'DUPLICATE_EVENT');
 const {rows}=await pool.query(
  'SELECT o.state, e.state AS entitlement_state FROM orders o JOIN entitlements e ON e.source_order_id=o.id WHERE o.id=$1',
  [order.id]);
 assert.equal(rows[0].state,'PAID');
 assert.equal(rows[0].entitlement_state,'PAID_PENDING_PROVISIONING');
});
test('independent website Prodamus referral checkout and late signed capture',async()=>{
 const inviter=81838301;
 const offers=await db.referralOffers(inviter,16);
 const offer=offers.find(o=>o.planId===planId);
 assert.ok(offer);
 const accountId=randomUUID();
 await pool.query('INSERT INTO accounts(id) VALUES($1)',[accountId]);
 let asked=0;
 const checkout=await prepareWebsiteProdamusCheckout({
  accountId,planId,requestId:'independent-site-'+suffix,inviteToken:offer.token,
 },db,payform,{
  getLink:async signed=>{
   asked++;
   const u=new URL(signed);
   assert.equal(u.searchParams.get('order_id')!==null,true);
   return 'https://payform.ru/u8zDE/';
  }
 });
 assert.equal(checkout.paymentUrl,'https://payform.ru/u8zDE/');
 assert.equal(asked,1);
 const ref=await pool.query('SELECT invite_token FROM order_referrals WHERE order_id=$1',
  [checkout.orderId]);
 assert.equal(ref.rows[0].invite_token,offer.token);
 await pool.query("UPDATE orders SET state='CANCELLED' WHERE id=$1",[checkout.orderId]);
 const fields={order_num:checkout.orderId,order_id:'capture-pd-'+suffix,
  domain:'merchant.payform.ru',sum:'199.00',payment_status:'success',attempt:'1'};
 const verified=verifyProdamusPayment(fields,signProdamus(fields,secret),{
  id:checkout.orderId,provider:'prodamus',currency:'RUB',amountMinor:19900,state:'CANCELLED',
 },payform);
 assert.equal(verified.ok,true);
 if(!verified.ok)throw new Error('unreachable');
 assert.equal(await db.settleVerified({
  provider:'prodamus',orderId:checkout.orderId,
  providerEventId:verified.capture.providerEventId,
  providerTransactionId:verified.capture.providerTransactionId,
  payloadHash:verified.capture.payloadSha256,amount:19900,currency:'RUB',
 }),'APPLIED');
 const {rows}=await pool.query('SELECT state FROM orders WHERE id=$1',[checkout.orderId]);
 assert.equal(rows[0].state,'PAID');
});
