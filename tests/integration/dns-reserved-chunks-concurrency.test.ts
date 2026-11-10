import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';

// ONLY a disposable CI PostgreSQL database after migrations 0001..0111.
// This probes real PostgreSQL row locking with concurrent DB connections.
// No ingress traffic or private customer credentials are involved.
const pool=new Pool({
  host:process.env.PGHOST??'localhost',
  port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',
  password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
  max:8,connectionTimeoutMillis:5000,
});
after(async()=>pool.end());

test('parallel paid DNS reservations cannot allocate the same quota twice',async()=>{
  const account=randomUUID(),order=randomUUID();
  const ticket=randomUUID().slice(0,12);
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  await pool.query(`INSERT INTO orders(
    id,account_id,product,provider,amount_minor,currency)
    VALUES($1,$2,'smart_dns','mock',10000,'RUB')`,[order,account]);
  const paid=await pool.query(
    `SELECT settle_verified_payment($1,'mock',$2,$3,$4,10000,'RUB',3600,1000)
       AS outcome`,[order,'event-'+ticket,'capture-'+ticket,'a'.repeat(64)]);
  assert.equal(paid.rows[0].outcome,'APPLIED');

  const row=await pool.query(
    'SELECT id,revision FROM entitlements WHERE source_order_id=$1 AND product=$2',
    [order,'smart_dns']);
  const entitlement=row.rows[0].id as string;
  await pool.query("UPDATE entitlements SET state='ACTIVE' WHERE id=$1",[entitlement]);
  await pool.query(`INSERT INTO provisioning_state(
    entitlement_id,adapter,applied_revision,last_observed_at)
    VALUES($1,'smart_dns',$2,clock_timestamp())`,
    [entitlement,row.rows[0].revision]);

  // 20 independent callers contest a 1000-byte package in parallel.
  // Exactly four 250-byte reservations may win; all others fail closed.
  const ids=Array.from({length:20},(_,i)=>`race-${ticket}-${String(i).padStart(2,'0')}`);
  const outcomes=await Promise.all(ids.map(async id=>{
    const r=await pool.query(
      'SELECT reserve_smart_dns_chunk($1,$2,250) AS status',
      [entitlement,id]);
    return {id,status:r.rows[0].status as string};
  }));
  const allowed=outcomes.filter(o=>o.status==='RESERVED');
  const denied=outcomes.filter(o=>o.status==='DENY_QUOTA');
  assert.equal(allowed.length,4,JSON.stringify(outcomes));
  assert.equal(denied.length,16,JSON.stringify(outcomes));

  const held=await pool.query(`SELECT COALESCE(sum(reserved_bytes),0)::bigint AS held
    FROM smart_dns_quota_reservations WHERE entitlement_id=$1 AND state='HELD'`,
  [entitlement]);
  assert.equal(held.rows[0].held,'1000');
  let usage=await pool.query(
    'SELECT quota_used_bytes FROM entitlements WHERE id=$1',[entitlement]);
  assert.equal(usage.rows[0].quota_used_bytes,'0');

  // Each chunk actually forwards only 200, returning 50 unused bytes.
  const settled=await Promise.all(allowed.map(async({id})=>{
    const r=await pool.query(
      'SELECT settle_smart_dns_chunk($1,$2,100,100) AS status',
      [entitlement,id]);
    return r.rows[0].status as string;
  }));
  assert.deepEqual(settled,['SETTLED','SETTLED','SETTLED','SETTLED']);
  usage=await pool.query(
    'SELECT quota_used_bytes,quota_state FROM entitlements WHERE id=$1',
    [entitlement]);
  assert.equal(usage.rows[0].quota_used_bytes,'800');
  assert.equal(usage.rows[0].quota_state,'AVAILABLE');

  const finalId=`final-${ticket}`;
  const next=await pool.query(
    'SELECT reserve_smart_dns_chunk($1,$2,200) AS status',[entitlement,finalId]);
  assert.equal(next.rows[0].status,'RESERVED');
  const noMore=await pool.query(
    'SELECT reserve_smart_dns_chunk($1,$2,1) AS status',
    [entitlement,`extra-${ticket}`]);
  assert.equal(noMore.rows[0].status,'DENY_QUOTA');

  const done=await pool.query(
    'SELECT settle_smart_dns_chunk($1,$2,50,150) AS status',
    [entitlement,finalId]);
  assert.equal(done.rows[0].status,'SETTLED');
  usage=await pool.query(
    'SELECT quota_used_bytes,quota_state FROM entitlements WHERE id=$1',
    [entitlement]);
  assert.equal(usage.rows[0].quota_used_bytes,'1000');
  assert.equal(usage.rows[0].quota_state,'EXHAUSTED');

  const duplicate=await pool.query(
    'SELECT settle_smart_dns_chunk($1,$2,100,100) AS status',
    [entitlement,allowed[0].id]);
  assert.equal(duplicate.rows[0].status,'DUPLICATE');

  const events=await pool.query(`SELECT count(*)::int AS n,
    COALESCE(sum(bytes),0)::bigint AS bytes
    FROM quota_usage_events WHERE entitlement_id=$1`,[entitlement]);
  assert.equal(events.rows[0].n,5);
  assert.equal(events.rows[0].bytes,'1000');
});
