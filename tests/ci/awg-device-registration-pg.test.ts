/**
 * Disposable PostgreSQL verification of the actual SECURITY DEFINER
 * website X25519-public-only enrollment queue.
 * This NEVER touches RU188/FI217, public release, or real customers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';

const FI='fi-test-01';
const KEY=()=>randomBytes(32).toString('base64');

test('FI public-key registration is session scoped, one-device and fails closed',async()=>{
  assert.equal(process.env.PGDATABASE,'mnebyvpn_test',
    'AWG device test only on disposable CI PostgreSQL');
  const db=new Pool({host:'127.0.0.1',port:5432,user:'test',password:'test',
    database:'mnebyvpn_test',max:1,connectionTimeoutMillis:3000});
  const c=await db.connect();
  const role='mnebyvpn_fi_awg_ci_site';
  const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
  const session= randomBytes(32).toString('base64url');
  const sessionSha=createHash('sha256').update(session).digest('hex');
  const key=KEY(),foreign=KEY();
  const node=generateKeyPairSync('ed25519');
  let started=false;
  try{
    await c.query('BEGIN');started=true;
    await c.query('CREATE ROLE '+role+' NOLOGIN NOINHERIT');
    await c.query('GRANT USAGE ON SCHEMA public TO '+role);
    await c.query('GRANT EXECUTE ON FUNCTION '+
      'public.website_request_fi_awg_device(text,uuid,text),'+
      'public.website_fi_awg_device_status(text,uuid,text) TO '+role);
    await c.query('INSERT INTO accounts(id) VALUES($1)',[account]);
    await c.query("INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) "+
      "VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')",[order,account]);
    await c.query("INSERT INTO entitlements(id,account_id,source_order_id,product,state,"+
      "revision,starts_at,expires_at) "+
      "VALUES($1,$2,$3,'vpn','ACTIVE',11,now()-interval '1 minute',now()+interval '1 day')",
      [entitlement,account,order]);
    await c.query("INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) "+
      "VALUES($1,'vpn',11,clock_timestamp())",[entitlement]);
    await c.query("INSERT INTO website_sessions(token_sha256,account_id,expires_at) "+
      "VALUES($1,$2,now()+interval '20 minutes')",[sessionSha,account]);
    await c.query('INSERT INTO vpn_node_enrollment_inventory('+
      'node_id,endpoint_host,identity_public_spki) VALUES ($1,$2,$3)',[
      FI,'fi.mnebyvpn.site',
      node.publicKey.export({format:'der',type:'spki'}).toString('base64url'),
    ]);
    await c.query("UPDATE vpn_node_enrollment_inventory SET status='approved',"+
      "approved_at=clock_timestamp() WHERE node_id=$1",[FI]);
    await c.query("INSERT INTO vpn_node_enrollment_challenges("+
      "challenge_id,node_id,nonce_sha256,issued_at,expires_at,consumed_at) "+
      "VALUES($1,$2,$3,clock_timestamp()-interval '1 second',"+
      "clock_timestamp()+interval '2 minutes',clock_timestamp())",
      [randomUUID(),FI,randomBytes(32).toString('hex')]);
    await c.query("UPDATE vpn_node_enrollment_inventory SET status='enrolled',"+
      "enrolled_at=clock_timestamp() WHERE node_id=$1",[FI]);
    await c.query('INSERT INTO vpn_awg_node_pools('+
      'node_id,endpoint_host,server_public_key,subnet_cidr,state,'+
      'external_e2e_proof_sha256,verified_at) '+
      "VALUES($1,'fi.mnebyvpn.site',$2,'10.73.91.0/24','verified',"+
      "$3,clock_timestamp())",
      [FI,KEY(),'a'.repeat(64)]);
    const query='SELECT website_request_fi_awg_device($1,$2::uuid,$3) AS result';
    await c.query('SET LOCAL ROLE '+role);
    let r=await c.query(query,[sessionSha,entitlement,key]);
    assert.equal(r.rows[0].result,'DENY_ACCESS','Release stays off by default');
    await c.query('RESET ROLE');
    await c.query("UPDATE vpn_release_flags SET enabled=true WHERE feature='vpn_awg_clients'");
    await c.query('SET LOCAL ROLE '+role);
    r=await c.query(query,[sessionSha,entitlement,key]);
    assert.equal(r.rows[0].result,'QUEUED');
    assert.equal((await c.query(query,[sessionSha,entitlement,key])).rows[0].result,'QUEUED');
    assert.equal((await c.query(query,[sessionSha,entitlement,foreign])).rows[0].result,'DENY_BOUND');
    assert.equal((await c.query(query,['e'.repeat(64),entitlement,key])).rows[0].result,'DENY_ACCESS');
    assert.equal((await c.query('SELECT website_fi_awg_device_status($1,$2::uuid,$3) AS s',
      [sessionSha,entitlement,key])).rows[0].s,'QUEUED');
    await c.query('SAVEPOINT site_cannot_write');
    await assert.rejects(c.query(
      "UPDATE vpn_awg_device_requests SET state='staged' WHERE entitlement_id=$1",[entitlement]),
      {code:'42501'});
    await c.query('ROLLBACK TO SAVEPOINT site_cannot_write');
    await c.query('RESET ROLE');
    const state=await c.query('SELECT peer_public_key,state,billing_revision FROM vpn_awg_device_requests WHERE entitlement_id=$1',[entitlement]);
    assert.equal(state.rowCount,1);
    assert.equal(state.rows[0].peer_public_key,key);
    assert.equal(state.rows[0].state,'queued');
    assert.equal(state.rows[0].billing_revision,'11');
    await c.query('UPDATE website_sessions SET revoked_at=clock_timestamp() WHERE token_sha256=$1',[sessionSha]);
    await c.query('SET LOCAL ROLE '+role);
    assert.equal((await c.query(query,[sessionSha,entitlement,key])).rows[0].result,'DENY_ACCESS');
    assert.equal((await c.query('SELECT website_fi_awg_device_status($1,$2::uuid,$3) AS s',
      [sessionSha,entitlement,key])).rows[0].s,null);
    await c.query('RESET ROLE');
    console.log('FI_AWG_DEVICE_DISPOSABLE=AUTHORIZED_PUBLIC_ONLY;ONE_DEVICE=true;'+
      'REVOKED_SESSION_BLOCKED=true;PUBLIC_CANNOT_WRITE=true;CLIENT_RELEASE=false');
  }finally{
    if(started)await c.query('ROLLBACK');
    c.release();
    await db.end();
  }
});
