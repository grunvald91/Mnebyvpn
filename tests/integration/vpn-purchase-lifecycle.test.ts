import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {PgReconcileStore} from '../../packages/provisioning/src/pg-worker.ts';
import {PgVpnPurchaseNoticeQueue,processVpnPurchaseNotices,purchaseNoticeMessage,
  type PurchaseNotice} from '../../packages/notifications/src/vpn-purchase.ts';

const pool=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
  max:4,connectionTimeoutMillis:1500,
});
after(async()=>pool.end());
const store=new PgBillingStore(pool);
const suffix=randomUUID().slice(0,8);
test('Prodamus receipt is queued once; node-ready notice only after final node-ack; paid clock starts on first ack',async()=>{
  const account=randomUUID(),tg='943120123',planId='receipt-'+suffix;
  await pool.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',[account,tg]);
  await pool.query(`INSERT INTO billing_plans(id,product,title,duration_seconds,rub_minor,enabled)
      VALUES($1,'vpn','VPN · 15 дней',1296000,6000,true)`,[planId]);
  const order=await store.createWebsiteOrder(account,planId,'purchase-'+suffix);
  assert.equal(await store.settleVerified({provider:'prodamus',orderId:order.id,
    providerEventId:'paid:receipt-'+suffix,providerTransactionId:'receipt-'+suffix,
    amount:6000,currency:'RUB',payloadHash:'a'.repeat(64)}),'APPLIED');
  const r=await pool.query('SELECT id,starts_at,expires_at,state,revision FROM entitlements WHERE source_order_id=$1',
    [order.id]);
  assert.equal(r.rowCount,1);
  const id=r.rows[0].id as string;
  assert.equal(r.rows[0].starts_at,null,'payment must not start purchased access clock');
  assert.equal(r.rows[0].expires_at,null);
  const queue=new PgVpnPurchaseNoticeQueue(pool);
  const received:PurchaseNotice[]=[];
  const sender={send:async(job:PurchaseNotice)=>{
    received.push(job);
    return {status:'sent' as const};
  }};
  assert.equal((await processVpnPurchaseNotices(queue,sender)).sent,1);
  assert.deepEqual(received.map(x=>x.kind),['PAYMENT']);
  assert.equal(purchaseNoticeMessage(received[0]).text.includes('15 дней'),true);
  assert.equal((await processVpnPurchaseNotices(queue,sender)).sent,0);
  const before=await new PgReconcileStore(pool).readDesired(id);
  assert.equal(before.enabled,true);
  assert.equal(before.provisionalActivation,true);
  assert.ok(before.expiresAt);
  assert.ok(before.expiresAt!.getTime()-Date.now()<=5*60_000+2000);
  const fence=(await pool.query("SELECT claim_provisioning_fence($1,'vpn') AS fence",[id])).rows[0].fence;
  assert.equal((await pool.query("SELECT acknowledge_provisioning($1,'vpn',1,$2,true) AS ok",
    [id,fence])).rows[0].ok,true);
  const intermediate=(await pool.query('SELECT state,revision,starts_at,expires_at FROM entitlements WHERE id=$1',[id])).rows[0];
  assert.equal(intermediate.state,'PAID_PENDING_PROVISIONING');
  assert.equal(Number(intermediate.revision),2);
  assert.ok(intermediate.starts_at instanceof Date);
  assert.equal(intermediate.expires_at.getTime()-intermediate.starts_at.getTime(),1296000_000);
  const credit=(await pool.query('SELECT starts_at,ends_at FROM entitlement_credits WHERE order_id=$1',[order.id])).rows[0];
  assert.equal(credit.starts_at.getTime(),intermediate.starts_at.getTime());
  assert.equal(credit.ends_at.getTime(),intermediate.expires_at.getTime());
  assert.equal((await processVpnPurchaseNotices(queue,sender)).sent,0);
  assert.equal((await pool.query("SELECT acknowledge_provisioning($1,'vpn',2,$2,true) AS ok",
    [id,fence])).rows[0].ok,true);
  const active=(await pool.query('SELECT state,revision FROM entitlements WHERE id=$1',[id])).rows[0];
  assert.equal(active.state,'ACTIVE');
  assert.equal((await processVpnPurchaseNotices(queue,sender)).sent,1);
  assert.deepEqual(received.map(x=>x.kind),['PAYMENT','READY']);
  assert.equal((await processVpnPurchaseNotices(queue,sender)).sent,0,
    'redelivered webhook and repeated discovery never create second notice');
});

test('unlinked Prodamus buyer does not generate a Telegram message',async()=>{
  const account=randomUUID(),planId='no-chat-'+suffix;
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  await pool.query(`INSERT INTO billing_plans(id,product,title,duration_seconds,rub_minor,enabled)
      VALUES($1,'vpn','VPN 15d no chat',1296000,6000,true)`,[planId]);
  const order=await store.createWebsiteOrder(account,planId,'no-chat-'+suffix);
  assert.equal(await store.settleVerified({provider:'prodamus',orderId:order.id,
    providerEventId:'paid:no-chat-'+suffix,providerTransactionId:'no-chat-'+suffix,
    amount:6000,currency:'RUB',payloadHash:'b'.repeat(64)}),'APPLIED');
  const queue=new PgVpnPurchaseNoticeQueue(pool);
  await queue.discover();
  const r=await pool.query('SELECT count(*)::int AS n FROM vpn_purchase_notifications WHERE order_id=$1',[order.id]);
  assert.equal(r.rows[0].n,0);
});
