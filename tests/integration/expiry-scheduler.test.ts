import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {PgOutboxDispatcher} from '../../packages/provisioning/src/pg-worker.ts';

test('actual PostgreSQL expiry changes desired state, creates exactly one revoke signal',async()=>{
 const url='postgresql://'+(process.env.PGUSER||'test')+':'+
  (process.env.PGPASSWORD||'test')+'@'+(process.env.PGHOST||'localhost')+':'+
  (process.env.PGPORT||'5432')+'/'+(process.env.PGDATABASE||'mnebyvpn_test');
 const pool=new Pool({connectionString:url});
 const dispatcher=new PgOutboxDispatcher(pool);
 const account='eded1000-0000-4000-8000-000000000001';
 const order='eded1000-0000-4000-8000-000000000002';
 const ent='eded1000-0000-4000-8000-000000000003';
 try {
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  await pool.query(
    `INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
      VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')`,[order,account]);
  await pool.query(
    `INSERT INTO entitlements(id,account_id,source_order_id,product,
         state,revision,starts_at,expires_at)
      VALUES($1,$2,$3,'vpn','ACTIVE',2,now()-interval '25 hours',
        now()-interval '1 hour')`,[ent,account,order]);
  const changed=await dispatcher.expireDue();
  assert.ok(changed>=1);
  const {rows}=await pool.query('SELECT state,revision FROM entitlements WHERE id=$1',[ent]);
  assert.equal(rows[0].state,'EXPIRED');
  assert.equal(Number(rows[0].revision),3);
  const outbox=await pool.query(
    'SELECT desired_revision FROM reconcile_outbox WHERE entitlement_id=$1',[ent]);
  assert.equal(outbox.rowCount,1);
  assert.equal(Number(outbox.rows[0].desired_revision),3);
  await dispatcher.expireDue();
  const after=await pool.query(
    'SELECT count(*)::int AS n FROM reconcile_outbox WHERE entitlement_id=$1',[ent]);
  assert.equal(after.rows[0].n,1);
 }finally {
  await pool.query('DELETE FROM reconcile_outbox WHERE entitlement_id=$1',[ent]).catch(()=>{});
  await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[ent]).catch(()=>{});
  await pool.query('DELETE FROM entitlements WHERE id=$1',[ent]).catch(()=>{});
  await pool.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
  await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
  await pool.end();
 }
});
