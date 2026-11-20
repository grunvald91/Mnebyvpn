/** Real PostgreSQL contract: AWG material SQL works under a SELECT-only site role.
 * Disposable CI database ONLY, no FI217 network or production customer data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {loadVerifiedAwgMaterial} from '../../packages/provisioning/src/awg-subscriber-material.ts';

const ROLE='awg_material_ro_ci';
const COLS=[
  ['vpn_awg_node_pools','node_id,endpoint_host,listen_port,subnet_cidr,state,verified_at,server_public_key'],
  ['vpn_awg_peer_allocations','node_id,entitlement_id,peer_public_key,client_ipv4,state,revision,expires_at,last_command_sha256'],
  ['vpn_node_enrollment_inventory','node_id,status'],
  ['vpn_awg_command_outbox','node_id,entitlement_id,revision,op,signed_command,command_sha256,state,billing_revision,node_receipt_sha256'],
  ['vpn_release_flags','feature,enabled'],
  ['entitlements','id,product,state,revision,expires_at'],
  ['vpn_subscription_links','entitlement_id,token_sha256,revoked_at'],
  ['provisioning_state','entitlement_id,adapter,applied_revision,last_observed_at'],
] as const;
const key=Buffer.from([...Array.from({length:31},()=>1),2]).toString('base64');

test('material lookup SQL is executable with column-scoped SELECT only',async()=>{
  if(process.env.PGDATABASE!=='mnebyvpn_test')
    throw Error('Only disposable PostgreSQL CI database is supported');
  const db=new Client();
  await db.connect();
  let transaction=false;
  try{
    await db.query('BEGIN');transaction=true;
    await db.query('CREATE ROLE '+ROLE+' NOLOGIN NOINHERIT');
    await db.query('GRANT USAGE ON SCHEMA public TO '+ROLE);
    for(const [table,cols] of COLS)
      await db.query('GRANT SELECT ('+cols+') ON public.'+table+' TO '+ROLE);
    await db.query('SET LOCAL ROLE '+ROLE);
    const owner={entitlementId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      revision:11,expiresAt:new Date(Date.now()+86400000)};
    // Without a matching token and peer, successful safe result is null.
    // A SQL syntax or missing-permission issue throws and FAILS this test.
    const result=await loadVerifiedAwgMaterial(db as never,owner,key,key,key,
      'c'.repeat(64));
    assert.equal(result,null);
    const who=await db.query('SELECT current_user');
    assert.equal(who.rows[0]?.current_user,ROLE);
    await db.query('SAVEPOINT deny_write');
    await assert.rejects(db.query(
      "UPDATE vpn_release_flags SET enabled=true WHERE feature='vpn_awg_clients'"));
    await db.query('ROLLBACK TO SAVEPOINT deny_write');
    await db.query('RESET ROLE');
  }finally{
    if(transaction)await db.query('ROLLBACK');
    await db.end();
  }
});
