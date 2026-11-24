import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,randomBytes,verify} from 'node:crypto';
import {Pool} from 'pg';
import {buildFiDnsSnapshot,publishFiDnsSnapshotOnce,type FiSnapshotDatabase} from '../../packages/dns-policy/src/fi-dns-snapshot-publisher.ts';
import {fiDnsSnapshotTranscript} from '../../packages/dns-policy/src/fi-personal-dns-signed-snapshot.ts';

test('scoped FI publisher signs only active paid regional grants, including empty revoke snapshots',async()=>{
 assert.equal(process.env.PGDATABASE,'mnebyvpn_test');
 const pool=new Pool({max:1,connectionTimeoutMillis:2500}),db=await pool.connect();
 const key=generateKeyPairSync('ed25519');
 const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
 const label=randomBytes(6).toString('hex');
 const legacy=createHash('sha256').update(label).digest('hex');
 const regional=createHash('sha256').update('MNEBYVPN_COUNTRY_DNS_V1\0FI\0'+label,'ascii').digest('hex');
 const adapter:FiSnapshotDatabase={query:sql=>db.query<{snapshot:unknown}>(sql)};
 try{
  await db.query('BEGIN');
  await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  await db.query("INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) VALUES($1,$2,'smart_dns','fixture',20000,'RUB','PAID')",[order,account]);
  await db.query("INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,dns_query_quota_per_30d) VALUES($1,$2,$3,'smart_dns','ACTIVE',1,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',2)",[entitlement,account,order]);
  assert.equal((await db.query('SELECT issue_personal_dns_credential($1,$2,$3,2) AS result',[entitlement,label,legacy])).rows[0].result,'ISSUED');
  await db.query('INSERT INTO fi_dns_regional_credentials(entitlement_id,token_sha256,credential_revision) VALUES($1,$2,1)',[entitlement,regional]);
  await db.query('SET LOCAL ROLE mnebyvpn_fi_dns_publisher');
  const disabled=await buildFiDnsSnapshot(adapter,key.privateKey);
  assert.deepEqual(disabled.grants,[]);
  await db.query('RESET ROLE');
  await db.query('UPDATE fi_dns_meter_gate SET enabled=true');
  await db.query('SET LOCAL ROLE mnebyvpn_fi_dns_publisher');
  const active=await buildFiDnsSnapshot(adapter,key.privateKey);
  assert.ok(active.revision>disabled.revision);
  const grant=active.grants.find(g=>g.entitlementId===entitlement);
  assert.ok(grant);
  assert.equal(grant.tokenSha256,regional);
  assert.equal(grant.credentialRevision,1);
  assert.equal(grant.state,'ACTIVE');
  assert.ok(verify(null,fiDnsSnapshotTranscript(active),key.publicKey,Buffer.from(active.signature,'base64url')));
  assert.ok(!JSON.stringify(active).includes(label));
  let delivered=0;
  const sent=await publishFiDnsSnapshotOnce(adapter,key.privateKey,async s=>{
   assert.ok(s.revision>active.revision);delivered=s.revision;
  });
  assert.equal(sent,delivered);
  await db.query('RESET ROLE');
  await db.query('UPDATE fi_dns_regional_credentials SET revoked_at=clock_timestamp() WHERE entitlement_id=$1',[entitlement]);
  await db.query('SET LOCAL ROLE mnebyvpn_fi_dns_publisher');
  const revoked=await buildFiDnsSnapshot(adapter,key.privateKey);
  assert.ok(revoked.revision>sent);
  assert.ok(!revoked.grants.some(g=>g.entitlementId===entitlement));
  await db.query('RESET ROLE');
  await db.query('UPDATE fi_dns_meter_gate SET enabled=false');
  await db.query('SET LOCAL ROLE mnebyvpn_fi_dns_publisher');
  const stopped=await buildFiDnsSnapshot(adapter,key.privateKey);
  assert.ok(stopped.revision>revoked.revision);
  assert.deepEqual(stopped.grants,[]);
  await db.query('RESET ROLE');
  assert.equal((await db.query("SELECT has_table_privilege('mnebyvpn_fi_dns_publisher','public.fi_dns_regional_credentials','SELECT') AS allowed")).rows[0].allowed,false);
  assert.equal((await db.query("SELECT has_function_privilege('mnebyvpn_fi_dns_publisher','public.fi_dns_meter_apply(text,uuid,text)','EXECUTE') AS allowed")).rows[0].allowed,false);
 }finally{
  try{await db.query('ROLLBACK');}finally{db.release();await pool.end();}
 }
});
