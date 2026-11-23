/** Disposable PostgreSQL concurrency test. Never connects to RU188. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';

test('DE and FI atomically share one paid connection capacity',async()=>{
  assert.equal(process.env.PGDATABASE,'mnebyvpn_test','disposable database only');
  const db=new Pool({max:6,connectionTimeoutMillis:2500});
  const claim=async(id:string,session:string,node:string,peer:string)=>{
    const result=await db.query(
      'SELECT public.vpn_shared_connection_claim($1::uuid,$2::uuid,$3,$4) AS result',
      [id,session,node,peer]);return String(result.rows[0]?.result);
  };
  const release=async(id:string,session:string,node:string,peer:string)=>{
    const result=await db.query(
      'SELECT public.vpn_shared_connection_release($1::uuid,$2::uuid,$3,$4) AS result',
      [id,session,node,peer]);return String(result.rows[0]?.result);
  };
  const make=async(limit:1|3)=>{
    const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
    const bundle=limit===3;
    await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
    await db.query(
      "INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) "+
      "VALUES($1,$2,$3,'telegram_stars',500,'XTR','PAID')",
      [order,account,bundle?'bundle':'vpn']);
    await db.query(
      'INSERT INTO order_terms(order_id,plan_id,plan_title,duration_seconds,'+
      'dns_quota_bytes,expires_at,device_limit) VALUES($1,$2,$3,2592000,$4,'+
      "clock_timestamp()+interval '30 days',$5)",
      [order,bundle?'bundle_30d_3device':'vpn_30d_1device',
       'Disposable CI seat',bundle?1000000:null,limit]);
    await db.query(
      "INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,"+
      "starts_at,expires_at) VALUES($1,$2,$3,'vpn','ACTIVE',1,"+
      "clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day')",
      [entitlement,account,order]);
    await db.query(
      "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
      "VALUES($1,'vpn',1,clock_timestamp())",[entitlement]);
    return {entitlement,order};
  };
  const p='c'.repeat(64),q='d'.repeat(64),r='e'.repeat(64),s='f'.repeat(64);
  try{
    await db.query("INSERT INTO vpn_shared_connection_nodes(node_id,country_code,"+
      "node_public_key_sha256,enabled) VALUES"+
      "('ci-de','DE',repeat('a',64),true),('ci-fi','FI',repeat('b',64),true)");
    const first=await make(1);
    const sa=randomUUID(),sb=randomUUID();
    assert.equal(await claim(first.entitlement,sa,'ci-de',p),'DENY_DISABLED');
    await db.query("UPDATE vpn_release_flags SET enabled=true "+
      "WHERE feature='vpn_shared_connection_admission'");
    // Two separate pool connections claim at the same time, not sequentially.
    const results=await Promise.all([
      claim(first.entitlement,sa,'ci-de',p),
      claim(first.entitlement,sb,'ci-fi',q),
    ]);
    assert.deepEqual(results.sort(),['ADMITTED','DENY_LIMIT']);
    const {rows:one}=await db.query(
      "SELECT count(*)::int AS count FROM vpn_shared_connection_leases "+
      "WHERE entitlement_id=$1 AND state='ACTIVE' AND lease_until>clock_timestamp()",
      [first.entitlement]);
    assert.equal(one[0].count,1,'no oversubscription across countries');

    const three=await make(3);
    const sessions=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
    assert.equal(await claim(three.entitlement,sessions[0],'ci-de',p),'ADMITTED');
    assert.equal(await claim(three.entitlement,sessions[1],'ci-fi',q),'ADMITTED');
    assert.equal(await claim(three.entitlement,sessions[2],'ci-fi',r),'ADMITTED');
    assert.equal(await claim(three.entitlement,sessions[3],'ci-de',s),'DENY_LIMIT');
    assert.equal(await release(three.entitlement,sessions[1],'ci-fi',q),'RELEASED');
    assert.equal(await claim(three.entitlement,sessions[3],'ci-de',s),'ADMITTED');
    assert.equal(await claim(three.entitlement,sessions[1],'ci-fi',q),'DENY_REPLAY');
    // Simulated disconnect/lease timeout on CI only.
    await db.query(
      "UPDATE vpn_shared_connection_leases SET admitted_at=clock_timestamp()-interval '1 minute', lease_until=clock_timestamp()-interval '1 second' "+
      "WHERE entitlement_id=$1 AND connection_id=$2",
      [three.entitlement,sessions[2]]);
    assert.equal(await claim(three.entitlement,randomUUID(),'ci-fi',r),'ADMITTED');
    assert.equal(await claim(three.entitlement,sessions[2],'ci-fi',r),'DENY_REPLAY');
    await db.query("UPDATE orders SET state='REFUNDED' WHERE id=$1",[three.order]);
    assert.equal(await claim(three.entitlement,randomUUID(),'ci-de',p),'DENY_ENTITLEMENT');
    await db.query("UPDATE vpn_release_flags SET enabled=false "+
      "WHERE feature='vpn_shared_connection_admission'");
  }finally{
    await db.end();
  }
});
