import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgBillingStore } from '../../packages/billing/src/store.ts';
import { planWidgetKey } from '../../packages/telegram-ui/src/widget-104.ts';
import {referralPublicData} from '../../packages/telegram-ui/src/referral-widget.ts';
const pool=new Pool({host:process.env.PGHOST??'localhost',
 port:Number(process.env.PGPORT??5432),user:process.env.PGUSER??'test',
 password:process.env.PGPASSWORD??'test',database:process.env.PGDATABASE??'mnebyvpn_test',max:12});
const db=new PgBillingStore(pool);
const id='trial-'+randomUUID().slice(0,8);
const dnsId=id+'-dns',inviter=90900801,buyer=90900802,trialUser=90900803;
before(async()=>{
 await pool.query(
  `INSERT INTO billing_plans(id,product,title,duration_seconds,dns_quota_bytes,stars,rub_minor,enabled)
   VALUES ($1,'vpn','VPN 15',1296000,NULL,23,7900,true),
          ($2,'smart_dns','DNS 30',2592000,1073741824,31,8900,true)`,
  [id,dnsId]);
 await pool.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
 await pool.query("UPDATE trial_offers SET enabled=true,dns_quota_bytes=1073741824 WHERE product='smart_dns'");
});
after(async()=>{await pool.end()});
test('one free 24h trial per Telegram account even under concurrent calls',async()=>{
 const results=await Promise.all(Array.from({length:6},()=>db.grantTrial(trialUser,'vpn')));
 assert.deepEqual(results.map(x=>x.status).sort(),
  ['PENDING','PENDING','PENDING','PENDING','PENDING','GRANTED'].sort());
 const granted=results.find(x=>x.status==='GRANTED');
 assert.ok(granted?.orderId);
 const {rows}=await pool.query(
  `SELECT o.provider,o.state,o.amount_minor,e.product,e.state AS entitlement_state,
          extract(epoch FROM(e.expires_at-e.starts_at))::bigint AS duration
   FROM orders o JOIN entitlements e ON e.source_order_id=o.id
   WHERE o.id=$1`,[granted.orderId]);
 assert.equal(rows[0].provider,'internal_trial');
 assert.equal(rows[0].state,'TRIAL');
 assert.equal(Number(rows[0].amount_minor),0);
 assert.equal(rows[0].entitlement_state,'PAID_PENDING_PROVISIONING');
 assert.equal(rows[0].duration,null,
  '24h must not start while a node has not confirmed activation');
 const {rows:captures}=await pool.query('SELECT count(*)::int AS n FROM provider_captures WHERE order_id=$1',[granted.orderId]);
 assert.equal(captures[0].n,0);
 assert.equal(await db.pendingOutboxForOrder(granted.orderId!),1);
 assert.equal((await db.grantTrial(trialUser,'smart_dns')).status,'PENDING');
});
test('referral one-day Smart DNS trial attributes inviter and enforces explicit quota',async()=>{
 const offers=await db.referralOffers(inviter,16);
 const one=offers.find(o=>o.planId===dnsId);
 assert.ok(one);
 assert.equal(one.trialAvailable,true);
 const result=await db.grantTrial(buyer,'smart_dns',one.token);
 assert.equal(result.status,'GRANTED');
 assert.equal((await db.grantTrial(buyer,'smart_dns',one.token)).status,'PENDING');
 const {rows}=await pool.query(
  `SELECT g.invite_token,e.product,e.quota_limit_bytes,o.state
     FROM trial_grants g JOIN orders o ON o.id=g.order_id
     JOIN entitlements e ON e.source_order_id=o.id
    WHERE g.telegram_user_id=$1`,[String(buyer)]);
 assert.equal(rows[0].invite_token,one.token);
 assert.equal(rows[0].product,'smart_dns');
 assert.equal(BigInt(rows[0].quota_limit_bytes),1073741824n);
 assert.equal(rows[0].state,'TRIAL');
 await assert.rejects(()=>db.grantTrial(inviter,'smart_dns',one.token),/self-owned/);
});
test('concurrent checkout cap protects against mass pending invoices, replay remains safe',async()=>{
 const customer=90900804;
 const created=[];
 for(let n=0;n<3;n++){
  created.push(await db.createTelegramOrder(customer,id,'rate-'+n));
 }
 assert.equal(new Set(created.map(x=>x.id)).size,3);
 assert.equal((await db.createTelegramOrder(customer,id,'rate-0')).id,created[0].id);
 await assert.rejects(()=>db.createTelegramOrder(customer,id,'rate-3'),/PENDING_CHECKOUT_RATE_LIMIT/);
});
test('catalog-key validation rejects stale price even inside checkout transaction',async()=>{
 const first=await db.plan(id);
 assert.ok(first);
 const key=planWidgetKey(first);
 const order=await db.createTelegramOrder(90900805,id,'current-price',undefined,key);
 assert.equal(order.amount,23);
 await pool.query('UPDATE billing_plans SET stars=27 WHERE id=$1',[id]);
 await assert.rejects(
  ()=>db.createTelegramOrder(90900806,id,'old-price',undefined,key),/OFFER_CHANGED/);
 const current=await db.plan(id);
 assert.ok(current);
 assert.notEqual(planWidgetKey(current),key);
});
test('forwarded catalog supports eight configured 15/30/60/90-day rows',async()=>{
 const suffix=randomUUID().slice(0,6);
 // Published production prices and preceding fixtures occupy the first pages
 // of the global catalog. Isolate these eight offers for an accurate test.
 const active=(await pool.query('UPDATE billing_plans SET enabled=false WHERE enabled=true RETURNING id'))
   .rows.map(row=>String(row.id));
 const inserted:string[]=[];
 try{
  for(const product of ['vpn','smart_dns'] as const){
   for(const days of [15,30,60,90]){
    const id='term-'+product+'-'+days+'-'+suffix;
    await pool.query(
     `INSERT INTO billing_plans(id,product,title,duration_seconds,dns_quota_bytes,stars,rub_minor,enabled)
      VALUES($1,$2,$3,$4,$5,$6,$7,true)`,
     [id,product,product+' '+days,days*86400,product==='smart_dns'?'1073741824':null,days+2,days*100]);
    inserted.push(id);
   }
  }
  const offers=await db.referralOffers(90900807,16);
  const termOffers=offers.filter(x=>x.planId.endsWith(suffix));
  assert.equal(termOffers.length,8);
  const publicData=referralPublicData(termOffers,'MnebyvpnTestBot');
  const parsed=JSON.parse(publicData);
  assert.equal(parsed.o.length,8);
  assert.ok(Buffer.byteLength(publicData,'utf8')<=1024);
  assert.deepEqual(parsed.o.filter((r:number[])=>r[0]===1).map((r:number[])=>r[1]),[15,30,60,90]);
 }finally{
  if(inserted.length)await pool.query('UPDATE billing_plans SET enabled=false WHERE id=ANY($1::text[])',[inserted]);
  if(active.length)await pool.query('UPDATE billing_plans SET enabled=true WHERE id=ANY($1::text[])',[active]);
 }
});

test('bundle trial accepts an existing VPN or DNS referral without duplicating access',async()=>{
 await pool.query("UPDATE trial_offers SET enabled=true,dns_quota_bytes=1073741824 WHERE product='bundle'");
 const prior=await pool.query("SELECT product,enabled FROM trial_offers WHERE product IN ('vpn','smart_dns')");
 const referrer=90900821,recipient=90900822;
 await pool.query("UPDATE trial_offers SET enabled=false WHERE product IN ('vpn','smart_dns')");
 const offers=await db.referralOffers(referrer,16);
 for(const row of prior.rows)await pool.query('UPDATE trial_offers SET enabled=$2 WHERE product=$1',[row.product,row.enabled]);
 const invite=offers.find(o=>o.planId===dnsId);
 assert.ok(invite);
 assert.equal(invite.trialAvailable,true);
 await assert.rejects(()=>db.grantTrial(referrer,'bundle',invite.token),/self-owned/);
 const result=await db.grantTrial(recipient,'bundle',invite.token);
 assert.equal(result.status,'GRANTED');
 assert.ok(result.orderId);
 const {rows}=await pool.query(
  `SELECT g.invite_token,o.product AS order_product,o.amount_minor,e.product,
          e.starts_at,e.expires_at
     FROM trial_grants g JOIN orders o ON o.id=g.order_id
     JOIN entitlements e ON e.source_order_id=o.id
     WHERE g.order_id=$1 ORDER BY e.product`,[result.orderId]);
 assert.deepEqual(rows.map(r=>r.product),['smart_dns','vpn']);
 assert.ok(rows.every(r=>r.invite_token===invite.token&&r.order_product==='bundle'&&
  Number(r.amount_minor)===0&&r.starts_at===null&&r.expires_at===null));
 assert.equal((await db.grantTrial(recipient,'vpn')).orderId,result.orderId);
 assert.equal(await db.pendingOutboxForOrder(result.orderId!),2);
});

test('legacy verified email recovery may reserve a bundle but remains cohort restricted',async()=>{
 await pool.query("UPDATE trial_offers SET enabled=true,dns_quota_bytes=1073741824 WHERE product='bundle'");
 const account=randomUUID();
 await pool.query('INSERT INTO accounts(id,email_address) VALUES($1,$2)',[account,'bundle-'+account+'@example.org']);
 await assert.rejects(()=>db.grantTrial(account,'bundle',undefined,undefined,true),/Legacy email trial no longer eligible/);
 await pool.query("INSERT INTO website_vpn_trial_requests(account_id,device_hash,request_source) VALUES($1,NULL,'LEGACY_EMAIL')",[account]);
 const result=await db.grantTrial(account,'bundle',undefined,undefined,true);
 assert.equal(result.status,'GRANTED');
 assert.ok(result.orderId);
 const {rows}=await pool.query('SELECT product FROM entitlements WHERE source_order_id=$1 ORDER BY product',[result.orderId]);
 assert.deepEqual(rows.map(r=>r.product),['smart_dns','vpn']);
 assert.equal((await db.grantTrial(account,'bundle',undefined,undefined,true)).orderId,result.orderId);
});

test('bundle trial cannot be extended as a single paid component by an old client',async()=>{
 await pool.query("UPDATE trial_offers SET enabled=true,dns_quota_bytes=1073741824 WHERE product='bundle'");
 const actor=90900823;
 const grant=await db.grantTrial(actor,'bundle');
 assert.equal(grant.status,'GRANTED');
 const order=grant.orderId!;
 await pool.query("UPDATE trial_grants SET activated_at=statement_timestamp()-interval '1 minute',access_expires_at=statement_timestamp()+interval '23 hours 59 minutes' WHERE order_id=$1",[order]);
 await pool.query("UPDATE entitlements e SET starts_at=t.activated_at,expires_at=t.access_expires_at,state='ACTIVE' FROM trial_grants t WHERE t.order_id=$1 AND e.source_order_id=t.order_id",[order]);
 const rows=(await pool.query("SELECT id,product,account_id FROM entitlements WHERE source_order_id=$1",[order])).rows;
 for(const e of rows){
   await assert.rejects(()=>db.createWebsiteOrder(e.account_id,e.product==='vpn'?id:dnsId,'bundle-renew-'+e.product,undefined,e.id),/Renewal target not owned or not active yet/);
 }
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders WHERE account_id=$1",[rows[0].account_id])).rows[0].n,1);
});
