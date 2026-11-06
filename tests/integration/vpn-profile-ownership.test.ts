import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';

test('Telegram can retrieve only its own ACTIVE up-to-date and provisioned VPN entitlement',async()=>{
 const url='postgresql://'+(process.env.PGUSER||'test')+':'+
  (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
  (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
 const pool=new Pool({connectionString:url});
 const store=new PgBillingStore(pool);
 const account='cedd1000-0000-4000-8000-000000000001';
 const order='cedd1000-0000-4000-8000-000000000002';
 const ent='cedd1000-0000-4000-8000-000000000003';
 const owner=3911122911;
 try {
  await pool.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',
   [account,String(owner)]);
  await pool.query(
   `INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
     VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')`,[order,account]);
  await pool.query(
   `INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,
        starts_at,expires_at)
     VALUES($1,$2,$3,'vpn','ACTIVE',2,now()-interval '1 hour',now()+interval '23 hours')`,
   [ent,account,order]);
  assert.equal(await store.confirmedVpnProfile(owner),null);
  await pool.query(
   `INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,
      fencing_token,last_observed_at)
    VALUES($1,'vpn',1,2,now())`,[ent]);
  assert.equal(await store.confirmedVpnProfile(owner),null);
  await pool.query('UPDATE provisioning_state SET applied_revision=2 WHERE entitlement_id=$1',[ent]);
  assert.equal((await store.confirmedVpnProfile(owner))?.entitlementId,ent);
  assert.equal(await store.confirmedVpnProfile(owner+1),null);
  await pool.query("UPDATE entitlements SET expires_at=now()-interval '1 second' WHERE id=$1",[ent]);
  assert.equal(await store.confirmedVpnProfile(owner),null);
  await pool.query("UPDATE entitlements SET expires_at=now()+interval '23 hours',state='REFUNDED' WHERE id=$1",[ent]);
  assert.equal(await store.confirmedVpnProfile(owner),null);
 }finally{
  await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[ent]).catch(()=>{});
  await pool.query('DELETE FROM entitlements WHERE id=$1',[ent]).catch(()=>{});
  await pool.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
  await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
  await pool.end();
 }
});
