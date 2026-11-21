import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {registerOfflineSale,showOfflineSale} from '../../apps/service/src/manual-sales.ts';
import {issueOwnerOfflineSubscriptionLink} from '../../packages/provisioning/src/owner-offline-subscriptions.ts';

const pool=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
  max:3,connectionTimeoutMillis:1500,
});
test('offline 30-day bundle is atomic and never fakes PSP captures or sends to customers',async()=>{
  const op=887766,tag=randomUUID().replace(/-/g,'').slice(0,9);
  const handle='buyer_'+tag;
  try{
    const result=await registerOfflineSale(pool,op,op,'12345678','@'+handle+' 399');
    assert.match(result.text,/Личная продажа записана/);
    const id=/Заказ: ([0-9a-f-]{36})/.exec(result.text)?.[1];
    assert.ok(id);
    const order=await pool.query(
      'SELECT o.*,m.customer_label,m.receipt_reference,a.telegram_user_id '+
      'FROM orders o JOIN manual_sales m ON m.order_id=o.id '+
      'JOIN accounts a ON a.id=o.account_id WHERE o.id=$1',[id]);
    assert.equal(order.rowCount,1);
    assert.equal(order.rows[0].provider,'manual_sale');
    assert.equal(order.rows[0].state,'PAID');
    assert.equal(Number(order.rows[0].amount_minor),39900);
    assert.equal(order.rows[0].telegram_user_id,null);
    assert.equal(order.rows[0].receipt_reference,null);
    assert.equal(order.rows[0].customer_label,handle);
    const ents=await pool.query(
      'SELECT product,state,starts_at,expires_at,dns_query_quota_per_30d,revision '+
      'FROM entitlements WHERE source_order_id=$1 ORDER BY product',[id]);
    assert.equal(ents.rowCount,2);
    assert.deepEqual(ents.rows.map(x=>x.product),['smart_dns','vpn']);
    assert.ok(ents.rows.every(x=>x.state==='PAID_PENDING_PROVISIONING'));
    assert.equal(ents.rows[0].dns_query_quota_per_30d,'1000000');
    assert.equal(ents.rows[1].dns_query_quota_per_30d,null);
    assert.ok(ents.rows.every(x=>
      x.expires_at.getTime()-x.starts_at.getTime()===2592000_000));
    const outbox=await pool.query('SELECT count(*)::int n FROM reconcile_outbox WHERE entitlement_id IN '+
      '(SELECT id FROM entitlements WHERE source_order_id=$1)',[id]);
    assert.equal(outbox.rows[0].n,2);
    const credits=await pool.query('SELECT count(*)::int n FROM entitlement_credits WHERE order_id=$1',[id]);
    assert.equal(credits.rows[0].n,2);
    const psp=await pool.query('SELECT count(*)::int n FROM verified_payment_events WHERE order_id=$1',[id]);
    assert.equal(psp.rows[0].n,0);
    const dup=await registerOfflineSale(pool,op,op,'12345678','@'+handle+' 399');
    assert.match(dup.text,new RegExp(id));
    const blocked=await registerOfflineSale(pool,op,op,'87654321','@'+handle+' 399');
    assert.match(blocked.text,/уже существует/);
    const total=await pool.query('SELECT count(*)::int n FROM manual_sales WHERE customer_label=$1',[handle]);
    assert.equal(total.rows[0].n,1);
    const view=await showOfflineSale(pool,op,op,id!,true,true,Buffer.alloc(32,7));
    assert.match(view.text,/VPN-ссылка ещё недоступна/);
    assert.doesNotMatch(view.text,/https:\/\/cdn\.servgo\.ru:8443\/sub\//);
  }finally{await pool.end();}
});


test('owner offline VPN bearer is stable, scoped to ledger, ACK, revocation and expiration',async()=>{
  const op=887799,other=op+1;
  const key=randomBytes(32);
  const handle='audit_'+randomUUID().replace(/-/g,'').slice(0,9);
  const result=await registerOfflineSale(pool,op,op,'882299','@'+handle+' 399');
  const orderId=/Заказ: ([0-9a-f-]{36})/.exec(result.text)?.[1];
  assert.ok(orderId,result.text);
  const ent=(await pool.query("SELECT id FROM entitlements WHERE source_order_id=$1 AND product='vpn'",
    [orderId])).rows[0]?.id as string;
  assert.ok(ent);
  const issue=()=>issueOwnerOfflineSubscriptionLink(pool,op,orderId!,ent,key);
  assert.equal(await issue(),null,'no VPN bearer before node acknowledgement');
  assert.equal(await issueOwnerOfflineSubscriptionLink(pool,other,orderId!,ent,key),null);
  assert.equal(await issueOwnerOfflineSubscriptionLink(pool,op,orderId!,ent,Buffer.alloc(0)),null);
  const countsBefore=await pool.query('SELECT count(*)::int n FROM vpn_subscription_links WHERE entitlement_id=$1',[ent]);
  assert.equal(countsBefore.rows[0].n,0);
  // Test fixture simulates exactly the acknowledged active revision.
  await pool.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[ent]);
  await pool.query("INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
    "VALUES($1,'vpn',1,clock_timestamp()) ON CONFLICT(entitlement_id,adapter) DO UPDATE "+
    "SET applied_revision=1,last_observed_at=clock_timestamp()",[ent]);
  const first=await issue();
  assert.ok(first?.link.startsWith('https://cdn.servgo.ru:8443/sub/'));
  for(let i=0;i<5;i++)assert.equal((await issue())?.link,first?.link);
  assert.equal(await issueOwnerOfflineSubscriptionLink(pool,other,orderId!,ent,key),null);
  const links=await pool.query('SELECT token_sha256,revoked_at FROM vpn_subscription_links WHERE entitlement_id=$1',[ent]);
  assert.equal(links.rowCount,1,'refresh must not accumulate live bearer tokens');
  const token=first!.link.split('/').at(-1)!;
  assert.equal(links.rows[0].token_sha256,
    createHash('sha256').update(token,'utf8').digest('hex'));
  const view=await showOfflineSale(pool,op,op,orderId!,true,false,key);
  assert.match(view.text,new RegExp(token));
  assert.equal((await showOfflineSale(pool,op,op,orderId!,true,false,key)).text,view.text);
  await pool.query("UPDATE vpn_subscription_links SET revoked_at=clock_timestamp() WHERE entitlement_id=$1",[ent]);
  assert.equal(await issue(),null,'explicit revocation is permanent for that URL');
  const revokedView=await showOfflineSale(pool,op,op,orderId!,true,false,key);
  assert.doesNotMatch(revokedView.text,new RegExp(token));
  const linksAfter=await pool.query('SELECT count(*)::int n FROM vpn_subscription_links WHERE entitlement_id=$1',[ent]);
  assert.equal(linksAfter.rows[0].n,1);
});
