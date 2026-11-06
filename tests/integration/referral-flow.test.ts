import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore,pricedPlanForOrder,starsOrderFromDB} from '../../packages/billing/src/store.ts';
import {buildStarsInvoice} from '../../packages/billing/src/stars.ts';

const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:6});
const store=new PgBillingStore(pool);
const suffix=randomUUID().slice(0,8).replaceAll('-','');
const vpnId='000_ref_vpn_'+suffix;
const dnsId='000_ref_dns_'+suffix;
const inviter=8200551,buyer=8200552,otherInviter=8200553;
before(async()=>{
 await pool.query(
   `INSERT INTO billing_plans(id,product,title,duration_seconds,dns_quota_bytes,rub_minor,stars,enabled)
   VALUES($1,'vpn','Реферал VPN',2592000,NULL,19900,150,true),
         ($2,'smart_dns','Реферал DNS',2592000,10737418240,9900,75,true)`,
   [vpnId,dnsId]);
});
after(async()=>{await pool.end()});
test('referral invite is stable, attributed atomically, and survives plan-price mutation',async()=>{
 const offers=await store.referralOffers(inviter,16);
 const vpn=offers.find(x=>x.planId===vpnId);
 const dns=offers.find(x=>x.planId===dnsId);
 assert.ok(vpn && dns,'our enabled plans must be in the catalog');
 assert.equal(vpn.stars,150);
 assert.equal(dns.stars,75);
 assert.equal(vpn.rubMinor,19900);
 assert.equal(vpn.token.length,16);
 const again=await store.referralOffers(inviter,16);
 assert.equal(again.find(x=>x.planId===vpnId)?.token,vpn.token);
 const record=await store.createTelegramOrder(buyer,vpnId,'ref-flow-first',vpn.token);
 assert.equal(record.amount,150);
 const db=await pool.query(
   `SELECT r.invite_token, r.referrer_account_id, o.state
      FROM order_referrals r JOIN orders o ON o.id=r.order_id
      WHERE r.order_id=$1`,[record.id]);
 assert.equal(db.rows[0].invite_token,vpn.token);
 assert.equal(db.rows[0].state,'PENDING');
 const duplicates=await Promise.all(Array.from({length:3},
   ()=>store.createTelegramOrder(buyer,vpnId,'ref-flow-first',vpn.token)));
 assert.equal(new Set(duplicates.map(x=>x.id)).size,1);
 const {rows:counts}=await pool.query('SELECT count(*)::int AS n FROM order_referrals WHERE order_id=$1',[record.id]);
 assert.equal(counts[0].n,1);
 await pool.query('UPDATE billing_plans SET stars=300,title=$2 WHERE id=$1',[vpnId,'Обновлённый VPN']);
 const snapshot=pricedPlanForOrder(record);
 assert.equal(snapshot.title,'Реферал VPN');
 assert.equal(snapshot.stars,150);
 const invoice=buildStarsInvoice(starsOrderFromDB(record),snapshot,'secret'.repeat(8));
 assert.equal(invoice.prices[0].amount,150);
 const current=await store.referralPlan(vpn.token);
 assert.equal(current?.stars,300);
 await assert.rejects(()=>store.createTelegramOrder(inviter,vpnId,'self-ref',vpn.token),
   /Self-referral/);
 const secondOffers=await store.referralOffers(otherInviter,16);
 const otherToken=secondOffers.find(x=>x.planId===vpnId)?.token;
 assert.ok(otherToken);
 await assert.rejects(()=>store.createTelegramOrder(buyer,vpnId,'ref-flow-first',otherToken),
   /Request key reused with different referral/);
 const after=await pool.query('SELECT count(*)::int AS n FROM order_referrals WHERE order_id=$1',[record.id]);
 assert.equal(after.rows[0].n,1);
});
test('wrong token, invalid product or a disabled plan cannot create attributed order',async()=>{
 const offer=await store.referralOffers(inviter,16);
 const vpn=offer.find(x=>x.planId===vpnId);
 assert.ok(vpn);
 await assert.rejects(()=>store.createTelegramOrder(buyer,dnsId,'wrong-product',vpn.token),
  /Unknown or mismatched referral/);
 assert.equal(await store.referralPlan('AAAAAAAAAAAAAAAA'),null);
 await pool.query('UPDATE billing_plans SET enabled=false WHERE id=$1',[dnsId]);
 const dns=offer.find(x=>x.planId===dnsId);
 assert.ok(dns);
 assert.equal(await store.referralPlan(dns.token),null);
 await assert.rejects(()=>store.createTelegramOrder(buyer,dnsId,'disabled-product',dns.token),
  /Plan not offered/);
});
