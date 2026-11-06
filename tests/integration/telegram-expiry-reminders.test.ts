import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgVpnExpiryReminderQueue,processVpnExpiryReminders,
  type ReminderSender,type VpnExpiryReminder} from '../../packages/notifications/src/vpn-expiry.ts';

const pg={
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
};
test('PostgreSQL: exactly one 3d and 1d notice per active confirmed deadline, renewal cancels stale jobs',async()=>{
  const pool=new Pool({...pg,max:4});
  const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
  const userId='921442003';
  const queue=new PgVpnExpiryReminderQueue(pool);
  const delivered:VpnExpiryReminder[]=[];
  const sender:ReminderSender={async send(job){delivered.push(job);return {status:'sent'};}};
  try{
    await pool.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',[account,userId]);
    await pool.query(
      "INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) "+
      "VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')",[order,account]);
    await pool.query(
      "INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at) "+
      "VALUES($1,$2,$3,'vpn','ACTIVE',2,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '69 hours')",
      [entitlement,account,order]);
    await pool.query(
      "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
      "VALUES($1,'vpn',2,clock_timestamp())",[entitlement]);
    assert.deepEqual(await processVpnExpiryReminders(queue,sender),{
      discovered:1,sent:1,skipped:0,retried:0,failed:0,
    });
    assert.equal(delivered.length,1);
    assert.equal(delivered[0].daysBefore,3);
    assert.equal(delivered[0].telegramUserId,userId);
    await processVpnExpiryReminders(queue,sender);
    assert.equal(delivered.length,1,'3d reminder must never repeat for same deadline');
    // A renewal changes the expiry. Prior 3d deadline cannot be dispatched
    // after the node acknowledges the new revision.
    await pool.query(
      "UPDATE entitlements SET expires_at=clock_timestamp()+interval '20 days',revision=3 WHERE id=$1",
      [entitlement]);
    await pool.query(
      'UPDATE provisioning_state SET applied_revision=3,last_observed_at=clock_timestamp() WHERE entitlement_id=$1',
      [entitlement]);
    assert.equal(await queue.discover(),0);
    await pool.query(
      "UPDATE entitlements SET expires_at=clock_timestamp()+interval '20 hours',revision=4 WHERE id=$1",
      [entitlement]);
    await pool.query(
      'UPDATE provisioning_state SET applied_revision=4,last_observed_at=clock_timestamp() WHERE entitlement_id=$1',
      [entitlement]);
    await processVpnExpiryReminders(queue,sender);
    assert.equal(delivered.length,2);
    assert.equal(delivered[1].daysBefore,1);
    await processVpnExpiryReminders(queue,sender);
    assert.equal(delivered.length,2);
    const final=await pool.query(
      'SELECT days_before,status FROM vpn_expiry_reminders WHERE entitlement_id=$1 ORDER BY days_before DESC',
      [entitlement]);
    assert.equal(final.rowCount,2);
    assert.deepEqual(final.rows.map(r=>[r.days_before,r.status]),[[3,'SENT'],[1,'SENT']]);
    // No node confirmation => no notices, even for an ACTIVE DB row.
    await pool.query("UPDATE provisioning_state SET applied_revision=2 WHERE entitlement_id=$1",
      [entitlement]);
    await pool.query(
      "UPDATE entitlements SET expires_at=clock_timestamp()+interval '65 hours',revision=5 WHERE id=$1",
      [entitlement]);
    assert.equal(await queue.discover(),0);
  }finally{
    await pool.query('DELETE FROM vpn_expiry_reminders WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
    await pool.query('DELETE FROM reconcile_outbox WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
    await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
    await pool.query('DELETE FROM entitlements WHERE id=$1',[entitlement]).catch(()=>{});
    await pool.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
    await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
    await pool.end();
  }
});
test('PostgreSQL: Telegram outage is retried, permanent block is not retried',async()=>{
  const pool=new Pool({...pg,max:4});
  const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
  const queue=new PgVpnExpiryReminderQueue(pool);
  try{
    await pool.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',
      [account,'923743337']);
    await pool.query(
      "INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) "+
      "VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')",[order,account]);
    await pool.query(
      "INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at) "+
      "VALUES($1,$2,$3,'vpn','ACTIVE',2,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '23 hours')",
      [entitlement,account,order]);
    await pool.query(
      "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
      "VALUES($1,'vpn',2,clock_timestamp())",[entitlement]);
    const retry:ReminderSender={async send(){return {status:'retry',retryAfterSeconds:90};}};
    const first=await processVpnExpiryReminders(queue,retry);
    assert.equal(first.retried,1);
    const row=await pool.query(
      'SELECT status,attempts,next_attempt_at>clock_timestamp() AS delayed '+
      'FROM vpn_expiry_reminders WHERE entitlement_id=$1',[entitlement]);
    assert.equal(row.rows[0].status,'PENDING');
    assert.equal(row.rows[0].attempts,1);
    assert.equal(row.rows[0].delayed,true);
    const nothing=await processVpnExpiryReminders(queue,retry);
    assert.equal(nothing.retried,0,'backoff must prevent immediate duplicate');
    await pool.query(
      "UPDATE vpn_expiry_reminders SET next_attempt_at=clock_timestamp()-interval '1 second' "+
      "WHERE entitlement_id=$1",[entitlement]);
    const blocked:ReminderSender={async send(){return {status:'blocked'};}};
    const again=await processVpnExpiryReminders(queue,blocked);
    assert.equal(again.failed,1);
    const last=await pool.query(
      'SELECT status,attempts FROM vpn_expiry_reminders WHERE entitlement_id=$1',
      [entitlement]);
    assert.deepEqual([last.rows[0].status,last.rows[0].attempts],['FAILED',2]);
  }finally{
    await pool.query('DELETE FROM vpn_expiry_reminders WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
    await pool.query('DELETE FROM reconcile_outbox WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
    await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
    await pool.query('DELETE FROM entitlements WHERE id=$1',[entitlement]).catch(()=>{});
    await pool.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
    await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
    await pool.end();
  }
});
