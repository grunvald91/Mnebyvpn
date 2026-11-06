import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgBillingStore } from '../../packages/billing/src/store.ts';
import { PgReconcileStore } from '../../packages/provisioning/src/pg-worker.ts';

const pg = {
  host:process.env.PGHOST??'localhost',
  port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
};
const pool=new Pool({...pg,max:3,connectionTimeoutMillis:1000});
after(async()=>pool.end());
const store=new PgBillingStore(pool);
const suffix=randomUUID().slice(0,8);
async function capture(orderId:string,transactionId:string,amount:number){
  return store.settleVerified({
    provider:'prodamus',orderId,providerTransactionId:transactionId,
    providerEventId:'paid:'+transactionId,amount,currency:'RUB',payloadHash:'a'.repeat(64),
  });
}
test('confirmed renewal credits exactly one existing VPN entitlement, idempotently',async()=>{
  const accountId=randomUUID(), stranger=randomUUID(), planId='renew-vpn-'+suffix;
  await pool.query('INSERT INTO accounts(id) VALUES($1),($2)',[accountId,stranger]);
  await pool.query(`INSERT INTO billing_plans(id,product,title,duration_seconds,rub_minor,enabled)
    VALUES($1,'vpn','VPN renew integration',86400,9900,true)`,[planId]);
  const initial=await store.createWebsiteOrder(accountId,planId,'initial-'+suffix);
  assert.equal(await capture(initial.id,'charge-initial-'+suffix,9900),'APPLIED');
  const before=await pool.query('SELECT id,expires_at,revision FROM entitlements WHERE source_order_id=$1',[initial.id]);
  assert.equal(before.rowCount,1);
  const entitlementId=before.rows[0].id as string;
  await assert.rejects(
    store.createWebsiteOrder(stranger,planId,'stranger-'+suffix,undefined,entitlementId),
    /Renewal target not owned/);
  const renewed=await store.createWebsiteOrder(accountId,planId,'renew-'+suffix,undefined,entitlementId);
  const duplicate=await store.createWebsiteOrder(accountId,planId,'renew-'+suffix,undefined,entitlementId);
  assert.equal(renewed.id,duplicate.id);
  await assert.rejects(store.createWebsiteOrder(accountId,planId,'renew-'+suffix),
    /different renewal target/);
  assert.equal(await capture(renewed.id,'charge-renew-'+suffix,9900),'APPLIED');
  assert.equal(await capture(renewed.id,'charge-renew-'+suffix,9900),'DUPLICATE_EVENT');
  const afterRenew=await pool.query('SELECT id,expires_at,revision FROM entitlements WHERE id=$1',[entitlementId]);
  assert.equal(afterRenew.rowCount,1);
  assert.equal(afterRenew.rows[0].id,entitlementId);
  assert.equal((afterRenew.rows[0].expires_at as Date).getTime()-
    (before.rows[0].expires_at as Date).getTime(),86400_000);
  assert.equal(Number(afterRenew.rows[0].revision),Number(before.rows[0].revision)+1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM entitlements WHERE account_id=$1',[accountId])).rows[0].n,1);
  const renewedRefund=await store.applyVerifiedRefund({
    provider:'prodamus',orderId:renewed.id,transactionId:'charge-renew-'+suffix,
    refundEventId:'refund:charge-renew-'+suffix,payloadHash:'b'.repeat(64),
    amount:9900,currency:'RUB',
  });
  assert.equal(renewedRefund,'APPLIED');
  const afterRefund=await pool.query('SELECT expires_at FROM entitlements WHERE id=$1',[entitlementId]);
  assert.equal((afterRefund.rows[0].expires_at as Date).getTime(),
    (before.rows[0].expires_at as Date).getTime());
  // Locking one connection must not wait forever for another checkout from
  // a pool of exactly one. readDesired and requestReconcile use that client.
  const tiny=new Pool({...pg,max:1,connectionTimeoutMillis:250});
  try{
    const reconcile=new PgReconcileStore(tiny);
    const read=await reconcile.withLock(entitlementId,async()=>{
      const desired=await reconcile.readDesired(entitlementId);
      await reconcile.requestReconcile(entitlementId,'test_single_connection');
      return desired;
    });
    assert.equal(read.entitlementId,entitlementId);
  }finally{await tiny.end();}
});
test('Smart DNS renewal adds purchased quota without resetting spent bytes',async()=>{
  const accountId=randomUUID(), planId='renew-dns-'+suffix;
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[accountId]);
  await pool.query(`INSERT INTO billing_plans(id,product,title,duration_seconds,dns_quota_bytes,rub_minor,enabled)
    VALUES($1,'smart_dns','DNS renew integration',86400,1048576,5000,true)`,[planId]);
  const first=await store.createWebsiteOrder(accountId,planId,'dns-initial-'+suffix);
  assert.equal(await capture(first.id,'charge-dns-initial-'+suffix,5000),'APPLIED');
  const row=await pool.query('SELECT id FROM entitlements WHERE source_order_id=$1',[first.id]);
  const target=row.rows[0].id as string;
  await pool.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[target]);
  const metered=await pool.query('SELECT debit_smart_dns_quota($1,$2,$3) AS result',
    [target,'dns-renew-usage-'+suffix,131072]);
  assert.equal(metered.rows[0].result,'ACCEPTED');
  const renewal=await store.createWebsiteOrder(accountId,planId,'dns-renew-'+suffix,undefined,target);
  assert.equal(await capture(renewal.id,'charge-dns-renew-'+suffix,5000),'APPLIED');
  const afterRenew=await pool.query('SELECT quota_limit_bytes,quota_used_bytes FROM entitlements WHERE id=$1',[target]);
  assert.equal(afterRenew.rows[0].quota_limit_bytes,'2097152');
  assert.equal(afterRenew.rows[0].quota_used_bytes,'131072');
});
