import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgOutboxDispatcher} from '../../packages/provisioning/src/pg-worker.ts';

test('VPN drift reconciliation never schedules Smart DNS entitlement',async()=>{
 const pool=new Pool({host:process.env.PGHOST??'localhost',
   port:Number(process.env.PGPORT??5432),
   user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
   database:process.env.PGDATABASE??'mnebyvpn_test',max:3});
 const account=randomUUID(),orders=[randomUUID(),randomUUID()],
   vpn=randomUUID(),dns=randomUUID();
 try{
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  for(let i=0;i<2;i++) {
   await pool.query(
    `INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
      VALUES($1,$2,$3,'internal_trial',0,'XTR','TRIAL')`,
    [orders[i],account,i===0?'vpn':'smart_dns']);
  }
  for(const [id,order,product] of [[vpn,orders[0],'vpn'],[dns,orders[1],'smart_dns']]){
   await pool.query(
    `INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,
      starts_at,expires_at,quota_limit_bytes)
      VALUES($1,$2,$3,$4,'EXPIRED',2,now()-interval '25 hours',
        now()-interval '1 hour',$5)`,
    [id,account,order,product,product==='smart_dns'?'1048576':null]);
  }
  const worker=new PgOutboxDispatcher(pool);
  await worker.scheduleDriftScan(100,['vpn']);
  const rows=await pool.query(
    'SELECT entitlement_id FROM reconcile_outbox WHERE entitlement_id=ANY($1::uuid[])',
    [[vpn,dns]]);
  assert.deepEqual(rows.rows.map(r=>r.entitlement_id),[vpn]);
  await assert.rejects(worker.scheduleDriftScan(100,[]));
  await assert.rejects(worker.scheduleDriftScan(100,['invalid' as 'vpn']));
 }finally{
  await pool.query('DELETE FROM reconcile_outbox WHERE entitlement_id=ANY($1::uuid[])',[[vpn,dns]]).catch(()=>{});
  await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=ANY($1::uuid[])',[[vpn,dns]]).catch(()=>{});
  await pool.query('DELETE FROM entitlements WHERE id=ANY($1::uuid[])',[[vpn,dns]]).catch(()=>{});
  await pool.query('DELETE FROM orders WHERE id=ANY($1::uuid[])',[orders]).catch(()=>{});
  await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
  await pool.end();
 }
});

test('VPN drift reconciliation skips reconciled terminal rows while keeping active and unapplied terminal rows',async()=>{
 const pool=new Pool({host:process.env.PGHOST??'localhost',
   port:Number(process.env.PGPORT??5432),
   user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
   database:process.env.PGDATABASE??'mnebyvpn_test',max:3});
 const account=randomUUID(),orders=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
 const activeStale=randomUUID(),terminalReconciled=randomUUID(),
   cancelledUnapplied=randomUUID(),refundedReconciled=randomUUID();
 const ids=[activeStale,terminalReconciled,cancelledUnapplied,refundedReconciled];
 try{
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  for(const order of orders){
   await pool.query(
    `INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
      VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')`,[order,account]);
  }
  await pool.query(
   `INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at)
     VALUES
     ($1,$5,$6,'vpn','ACTIVE',3,now()-interval '2 hours',now()+interval '20 hours'),
     ($2,$5,$7,'vpn','EXPIRED',4,now()-interval '25 hours',now()-interval '1 hour'),
     ($3,$5,$8,'vpn','CANCELLED',5,now()-interval '25 hours',now()-interval '1 hour'),
     ($4,$5,$9,'vpn','REFUNDED',6,now()-interval '25 hours',now()-interval '1 hour')`,
   [activeStale,terminalReconciled,cancelledUnapplied,refundedReconciled,account,...orders]);
  await pool.query(
   `INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,fencing_token,last_observed_at)
     VALUES
     ($1,'vpn',3,1,now()-interval '2 hours'),
     ($2,'vpn',4,1,now()-interval '2 hours'),
     ($3,'vpn',4,1,now()-interval '2 hours'),
     ($4,'vpn',6,1,now()-interval '2 hours')`,
   ids);
  const worker=new PgOutboxDispatcher(pool);
  await worker.scheduleDriftScan(500,['vpn']);
  const rows=await pool.query(
   'SELECT entitlement_id FROM reconcile_outbox WHERE entitlement_id=ANY($1::uuid[]) ORDER BY entitlement_id',
   [ids]);
  assert.deepEqual(
   rows.rows.map(r=>String(r.entitlement_id)).sort(),
   [activeStale,cancelledUnapplied].sort(),
  );
 }finally{
  await pool.query('DELETE FROM reconcile_outbox WHERE entitlement_id=ANY($1::uuid[])',[ids]).catch(()=>{});
  await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=ANY($1::uuid[])',[ids]).catch(()=>{});
  await pool.query('DELETE FROM entitlements WHERE id=ANY($1::uuid[])',[ids]).catch(()=>{});
  await pool.query('DELETE FROM orders WHERE id=ANY($1::uuid[])',[orders]).catch(()=>{});
  await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
  await pool.end();
 }
});
