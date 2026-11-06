import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';

const pool=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
  max:4,connectionTimeoutMillis:1500,
});
after(async()=>pool.end());
const db=new PgBillingStore(pool);
const unique=()=>randomUUID().slice(0,8);
function event(orderId:string,txn:string,amount:number){
  return {
    provider:'prodamus' as const,orderId,providerTransactionId:txn,
    providerEventId:'paid:'+txn,amount,currency:'RUB' as const,
    payloadHash:'a'.repeat(64),
  };
}
async function newSubscription(product:'vpn'|'smart_dns',duration=86400,quota=1048576){
  const accountId=randomUUID(),planId='credit-'+unique(),amount=7000;
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[accountId]);
  await pool.query(`INSERT INTO billing_plans
    (id,product,title,duration_seconds,rub_minor,dns_quota_bytes,enabled)
    VALUES ($1,$2,'Credit lifecycle', $3,$4,$5,true)`,
    [planId,product,duration,amount,product==='smart_dns'?quota:null]);
  const first=await db.createWebsiteOrder(accountId,planId,'initial-'+unique());
  const txn='txn-'+unique();
  assert.equal(await db.settleVerified(event(first.id,txn,amount)),'APPLIED');
  const {rows}=await pool.query(
    'SELECT * FROM entitlements WHERE source_order_id=$1',[first.id]);
  assert.equal(rows.length,1);
  return {accountId,planId,first,txn,entitlementId:rows[0].id as string,amount,duration,quota};
}
async function renew(f:Awaited<ReturnType<typeof newSubscription>>){
  const order=await db.createWebsiteOrder(f.accountId,f.planId,'renew-'+unique(),
    undefined,f.entitlementId);
  const txn='txn-'+unique();
  assert.equal(await db.settleVerified(event(order.id,txn,f.amount)),'APPLIED');
  return {order,txn};
}
async function refund(orderId:string,txn:string,amount:number){
  return db.applyVerifiedRefund({
    provider:'prodamus',orderId,transactionId:txn,refundEventId:'refund:'+txn,
    payloadHash:'b'.repeat(64),amount,currency:'RUB',
  });
}
async function entitlement(id:string){
  const r=await pool.query('SELECT * FROM entitlements WHERE id=$1',[id]);
  return r.rows[0];
}
const ms=(d:Date)=>d.getTime();
test('refund of original payment preserves all bought renewal time, no second entitlement',async()=>{
  const f=await newSubscription('vpn');
  const e1=await entitlement(f.entitlementId);
  const renewal=await renew(f);
  const expanded=await entitlement(f.entitlementId);
  assert.equal(ms(expanded.expires_at)-ms(e1.expires_at),f.duration*1000);
  const refundedAt=Date.now();
  assert.equal(await refund(f.first.id,f.txn,f.amount),'APPLIED');
  const result=await entitlement(f.entitlementId);
  assert.equal(result.state,'PAID_PENDING_PROVISIONING');
  assert.ok(Math.abs(ms(result.expires_at)-(refundedAt+f.duration*1000))<10000);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM entitlements WHERE account_id=$1',
    [f.accountId])).rows[0].n,1);
  const credit=await pool.query(
    'SELECT refunded_at,credit_sequence FROM entitlement_credits WHERE entitlement_id=$1 ORDER BY credit_sequence',
    [f.entitlementId]);
  assert.equal(credit.rows.length,2);
  assert.ok(credit.rows[0].refunded_at);
  assert.equal(credit.rows[1].refunded_at,null);
  assert.equal(await refund(f.first.id,f.txn,f.amount),'DUPLICATE_EVENT');
  assert.equal(ms((await entitlement(f.entitlementId)).expires_at),ms(result.expires_at));
  assert.equal(await refund(renewal.order.id,renewal.txn,f.amount),'APPLIED');
  assert.equal((await entitlement(f.entitlementId)).state,'REFUNDED');
});
test('refund of middle renewal shifts later purchased period but retains duration',async()=>{
  const f=await newSubscription('vpn');
  const middle=await renew(f);
  const last=await renew(f);
  const expanded=await entitlement(f.entitlementId);
  assert.equal(await refund(middle.order.id,middle.txn,f.amount),'APPLIED');
  const afterMiddle=await entitlement(f.entitlementId);
  assert.equal(ms(expanded.expires_at)-ms(afterMiddle.expires_at),f.duration*1000);
  assert.equal(await refund(f.first.id,f.txn,f.amount),'APPLIED');
  const afterOriginal=await entitlement(f.entitlementId);
  assert.equal(afterOriginal.state,'PAID_PENDING_PROVISIONING');
  assert.ok(Math.abs(ms(afterOriginal.expires_at)-(Date.now()+f.duration*1000))<10000);
  assert.equal(await refund(last.order.id,last.txn,f.amount),'APPLIED');
  assert.equal((await entitlement(f.entitlementId)).state,'REFUNDED');
});
test('refunded original after its period has passed does not shorten later paid renewal',async()=>{
  const f=await newSubscription('vpn');
  const renewal=await renew(f);
  // Offline clock fixture: place the original credit into the past while the
  // subsequent purchased credit is currently active. Simulates late refund.
  const now=Date.now();
  const firstStart=new Date(now-2*f.duration*1000);
  const firstEnd=new Date(now-f.duration*1000);
  const renewEnd=new Date(now+f.duration*1000);
  await pool.query(`UPDATE entitlement_credits SET starts_at=$2,ends_at=$3
    WHERE entitlement_id=$1 AND credit_sequence=0`,[f.entitlementId,firstStart,firstEnd]);
  await pool.query(`UPDATE entitlement_credits SET starts_at=$2,ends_at=$3
    WHERE entitlement_id=$1 AND credit_sequence=1`,[f.entitlementId,firstEnd,renewEnd]);
  await pool.query('UPDATE entitlements SET starts_at=$2,expires_at=$3 WHERE id=$1',
    [f.entitlementId,firstStart,renewEnd]);
  assert.equal(await refund(f.first.id,f.txn,f.amount),'APPLIED');
  const after=await entitlement(f.entitlementId);
  assert.equal(ms(after.expires_at),ms(renewEnd));
  assert.equal(after.state,'PAID_PENDING_PROVISIONING');
  assert.equal(await refund(renewal.order.id,renewal.txn,f.amount),'APPLIED');
});
test('DNS refund preserves consumed byte ledger; a new renewal grants a fresh real quota',async()=>{
  const f=await newSubscription('smart_dns');
  const renewal=await renew(f);
  await pool.query('UPDATE entitlements SET quota_used_bytes=$2 WHERE id=$1',
    [f.entitlementId,524288]);
  assert.equal(await refund(f.first.id,f.txn,f.amount),'APPLIED');
  let e=await entitlement(f.entitlementId);
  assert.equal(e.quota_limit_bytes,String(f.quota));
  assert.equal(e.quota_used_bytes,'524288');
  assert.equal(e.quota_state,'AVAILABLE');
  assert.equal(await refund(renewal.order.id,renewal.txn,f.amount),'APPLIED');
  e=await entitlement(f.entitlementId);
  assert.equal(e.state,'REFUNDED');
  assert.equal(e.quota_limit_bytes,'524288');
  assert.equal(e.quota_state,'EXHAUSTED');
});
test('previously authorized renewal capture after original refund restores only purchased period',async()=>{
  const f=await newSubscription('vpn');
  const pending=await db.createWebsiteOrder(f.accountId,f.planId,'pending-'+unique(),
    undefined,f.entitlementId);
  assert.equal(await refund(f.first.id,f.txn,f.amount),'APPLIED');
  assert.equal((await entitlement(f.entitlementId)).state,'REFUNDED');
  // The checkout was valid at creation time. A subsequently confirmed capture
  // must not strand the payment even if its older subscription got refunded.
  const txn='txn-'+unique();
  assert.equal(await db.settleVerified(event(pending.id,txn,f.amount)),'APPLIED');
  const result=await entitlement(f.entitlementId);
  assert.equal(result.state,'PAID_PENDING_PROVISIONING');
  assert.ok(Math.abs(ms(result.expires_at)-(Date.now()+f.duration*1000))<10000);
  await assert.rejects(db.createWebsiteOrder(f.accountId,f.planId,'void-'+unique(),
    undefined,f.entitlementId),/Renewal target not owned/);
});
