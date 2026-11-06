import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {rublePlanKey} from '../../packages/billing/src/offer-keys.ts';
const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
 user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
 database:process.env.PGDATABASE??'mnebyvpn_test',max:5});
const db=new PgBillingStore(pool);
const suffix=randomUUID().slice(0,8);
const planId='rub-ref-'+suffix,owner=99112201,buyer=99112202,other=99112203;
const token=randomBytes(12).toString('base64url');
before(async()=>{
 await pool.query(
  "INSERT INTO billing_plans(id,product,title,duration_seconds,stars,rub_minor,enabled) "+
  "VALUES($1,'vpn','Оплата VPN за рубли',1296000,31,19800,true)",[planId]);
 const ownerAccount=await pool.query(
  "INSERT INTO accounts(id,telegram_user_id) VALUES(gen_random_uuid(),$1) "+
  "ON CONFLICT(telegram_user_id) DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id RETURNING id",
  [String(owner)]);
 await pool.query(
  'INSERT INTO referral_invites(token,referrer_account_id,plan_id) VALUES($1,$2,$3)',
  [token,ownerAccount.rows[0].id,planId]);
});
after(async()=>pool.end());
test('RUB referral buyer creates a provider-specific immutable order and attribution',async()=>{
 const offer=await db.plan(planId);
 assert.ok(offer);
 const key=rublePlanKey(offer);
 const o=await db.createTelegramRubleOrder(buyer,planId,'rub-payment-1-'+suffix,token,key);
 assert.equal(o.provider,'prodamus');
 assert.equal(o.currency,'RUB');
 assert.equal(o.amount,19800);
 assert.equal(o.telegramUserId,buyer);
 const refs=await pool.query(
  'SELECT invite_token FROM order_referrals WHERE order_id=$1',[o.id]);
 assert.equal(refs.rows.length,1);
 assert.equal(refs.rows[0].invite_token,token);
 const outcome=await db.settleVerified({
  provider:'prodamus',orderId:o.id,providerEventId:'signed-event-'+suffix,
  providerTransactionId:'merchant-capture-'+suffix,amount:19800,currency:'RUB',
  payloadHash:'a'.repeat(64),
 });
 assert.equal(outcome,'APPLIED');
 const check=await pool.query(
  'SELECT state FROM orders WHERE id=$1',[o.id]);
 assert.equal(check.rows[0].state,'PAID');
 const active=await pool.query(
  'SELECT id FROM entitlements WHERE source_order_id=$1',[o.id]);
 assert.equal(active.rows.length,1);
});
test('wrong RUB price and a self-referral never create payable orders',async()=>{
 const original=await db.plan(planId);
 assert.ok(original);
 const key=rublePlanKey(original);
 await assert.rejects(
  ()=>db.createTelegramRubleOrder(owner,planId,'rub-self-'+suffix,token,key),/Self-referral/);
 await pool.query('UPDATE billing_plans SET rub_minor=21000 WHERE id=$1',[planId]);
 await assert.rejects(
  ()=>db.createTelegramRubleOrder(other,planId,'rub-old-'+suffix,token,key),/OFFER_CHANGED/);
 const checked=await pool.query(
  "SELECT count(*)::integer AS n FROM orders WHERE provider='prodamus' "+
  "AND account_id=(SELECT id FROM accounts WHERE telegram_user_id=$1)",
  [String(other)]);
 assert.equal(checked.rows[0].n,0);
});
