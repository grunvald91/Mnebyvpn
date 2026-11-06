import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:8});
after(async()=>pool.end());
const billing=new PgBillingStore(pool),suffix=randomUUID().slice(0,8);
const plan='renew-'+suffix,day=86400,quota=3n*1024n*1024n*1024n;
async function setup(product:'vpn'|'smart_dns',user:number){
 const id=plan+'-'+product;
 await pool.query(
  'INSERT INTO billing_plans(id,product,title,duration_seconds,dns_quota_bytes,stars,enabled) '+
  'VALUES($1,$2,$3,$4,$5,40,true) ON CONFLICT DO NOTHING',
  [id,product,'Repeat '+product,15*day,product==='vpn'?null:String(quota)]);
 return id;
}
async function capture(user:number,id:string,req:string){
 const o=await billing.createTelegramOrder(user,id,req);
 const status=await billing.settleVerified({
  provider:'telegram_stars',orderId:o.id,
  providerEventId:'event:'+req,providerTransactionId:'charge:'+req,
  payloadHash:'c'.repeat(64),amount:40,currency:'XTR',
 });
 assert.equal(status,'APPLIED');
 return o;
}
test('VPN renewal reuses entitlement and extends max(now,expires)+duration',async()=>{
 const user=8883101,id=await setup('vpn',user);
 const first=await capture(user,id,'rn1-'+suffix);
 const r1=await pool.query('SELECT id,starts_at,expires_at,revision FROM entitlements WHERE source_order_id=$1',[first.id]);
 assert.equal(r1.rows.length,1);
 const second=await capture(user,id,'rn2-'+suffix);
 const r2=await pool.query(
  'SELECT id,starts_at,expires_at,revision FROM entitlements WHERE account_id=$1 AND product=$2',
  [first.accountId,'vpn']);
 assert.equal(r2.rows.length,1,'must retain one credential per account/product');
 assert.equal(r1.rows[0].id,r2.rows[0].id);
 assert.equal(r2.rows[0].starts_at.getTime(),r1.rows[0].starts_at.getTime());
 assert.equal(r2.rows[0].expires_at.getTime()-r1.rows[0].expires_at.getTime(),15*day*1000);
 assert.equal(Number(r2.rows[0].revision),2);
 const credits=await pool.query(
  'SELECT order_id,entitlement_id FROM order_entitlement_credits WHERE order_id=ANY($1::uuid[])',
  [[first.id,second.id]]);
 assert.equal(credits.rows.length,2);
 assert.ok(credits.rows.every(x=>x.entitlement_id===r1.rows[0].id));
});
test('DNS renewal adds quota to the existing bucket, refund removes only credited time',async()=>{
 const user=8883102,id=await setup('smart_dns',user);
 const a=await capture(user,id,'dns1-'+suffix);
 const b=await capture(user,id,'dns2-'+suffix);
 const get=async()=>{const q=await pool.query(
  'SELECT id,expires_at,quota_limit_bytes,state,revision FROM entitlements WHERE account_id=$1 AND product=$2',
  [a.accountId,'smart_dns']);return q.rows[0];};
 let current=await get();
 assert.equal(BigInt(current.quota_limit_bytes),quota*2n);
 const before=current.expires_at.getTime();
 const result=await billing.applyVerifiedRefund({
  provider:'telegram_stars',orderId:b.id,transactionId:'charge:dns2-'+suffix,
  refundEventId:'refund:dns2-'+suffix,payloadHash:'d'.repeat(64),amount:40,currency:'XTR',
 });
 assert.equal(result,'APPLIED');
 current=await get();
 assert.equal(current.expires_at.getTime(),before-15*day*1000);
 assert.equal(BigInt(current.quota_limit_bytes),quota);
 assert.notEqual(current.state,'REFUNDED','first paid purchase stays valid');
 assert.equal((await pool.query('SELECT state FROM orders WHERE id=$1',[b.id])).rows[0].state,'REFUNDED');
 const secondRefund=await billing.applyVerifiedRefund({
  provider:'telegram_stars',orderId:a.id,transactionId:'charge:dns1-'+suffix,
  refundEventId:'refund:dns1-'+suffix,payloadHash:'e'.repeat(64),amount:40,currency:'XTR',
 });
 assert.equal(secondRefund,'APPLIED');
 assert.equal((await get()).state,'REFUNDED');
});
test('concurrent paid orders serialize into the same credential',async()=>{
 const user=8883103,id=await setup('vpn',user);
 const [a,b]=await Promise.all([
  capture(user,id,'con1-'+suffix),capture(user,id,'con2-'+suffix),
 ]);
 const q=await pool.query('SELECT id,revision FROM entitlements WHERE account_id=$1 AND product=$2',
  [a.accountId,'vpn']);
 assert.equal(q.rows.length,1);
 assert.equal(Number(q.rows[0].revision),2);
 const credits=await pool.query('SELECT count(*)::int AS n FROM order_entitlement_credits WHERE order_id=ANY($1::uuid[])',
  [[a.id,b.id]]);
 assert.equal(credits.rows[0].n,2);
});
