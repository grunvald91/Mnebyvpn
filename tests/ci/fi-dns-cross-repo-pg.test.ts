/** Real Ed25519 + scoped PostgreSQL RPC, disposable DB only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {AddressInfo,Server} from 'node:net';
import {startFiMeterLoopbackServer} from '../../packages/dns-policy/src/fi-dns-meter-loopback.ts';
import {buildFiDnsSnapshot} from '../../packages/dns-policy/src/fi-dns-snapshot-publisher.ts';
const exec=promisify(execFile);
import {handleFiMeterRequest,type MeterDatabase} from '../../packages/dns-policy/src/fi-dns-meter-rpc.ts';

test('actual FI Python DoT TLS client, signed policy and TCP RPC charge one common database quota',async()=>{
 assert.equal(process.env.PGDATABASE,'mnebyvpn_test');
 const pool=new Pool({max:1,connectionTimeoutMillis:2500});
 const db=await pool.connect();
 const node=generateKeyPairSync('ed25519'),controller=generateKeyPairSync('ed25519');
 const pin=(key:typeof node.publicKey)=>{
  const der=key.export({format:'der',type:'spki'});
  return {spki:der.toString('base64url'),sha256:createHash('sha256').update(der).digest('hex')};
 };
 const np=pin(node.publicKey);
 const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
 const label=randomBytes(6).toString('hex');
 const legacyDigest=createHash('sha256').update(label).digest('hex');
 const digest=createHash('sha256').update('MNEBYVPN_COUNTRY_DNS_V1\0FI\0'+label,'ascii').digest('hex');
 const root=await mkdtemp(join(tmpdir(),'fi-dns-e2e-'));
 const adapter:MeterDatabase={query:(sql,values)=>db.query<{result:unknown}>(sql,values)};
 let server:Server|undefined;
 try{
  await db.query('BEGIN');
  await db.query("INSERT INTO vpn_node_enrollment_inventory(node_id,endpoint_host,identity_public_spki) VALUES('fi-test-01','ci-meter-fi.example.org',$1)",[np.spki]);
  await db.query("UPDATE vpn_node_enrollment_inventory SET status='approved',approved_at=clock_timestamp() WHERE node_id='fi-test-01'");
  await db.query("INSERT INTO vpn_node_enrollment_challenges(challenge_id,node_id,nonce_sha256,issued_at,expires_at,consumed_at) VALUES($1,'fi-test-01',$2,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 minute',clock_timestamp())",[randomUUID(),randomBytes(32).toString('hex')]);
  await db.query("UPDATE vpn_node_enrollment_inventory SET status='enrolled',enrolled_at=clock_timestamp() WHERE node_id='fi-test-01'");
  await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  await db.query("INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) VALUES($1,$2,'smart_dns','fixture',20000,'RUB','PAID')",[order,account]);
  await db.query("INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,dns_query_quota_per_30d) VALUES($1,$2,$3,'smart_dns','ACTIVE',1,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',2)",[entitlement,account,order]);
  assert.equal((await db.query('SELECT issue_personal_dns_credential($1,$2,$3,2) AS result',[entitlement,label,legacyDigest])).rows[0].result,'ISSUED');
  await db.query('INSERT INTO fi_dns_regional_credentials(entitlement_id,token_sha256,credential_revision) VALUES($1,$2,1)',[entitlement,digest]);
  await db.query('UPDATE fi_dns_meter_gate SET enabled=true');

  await db.query('SET LOCAL ROLE mnebyvpn_fi_dns_publisher');
  const snapshot=await buildFiDnsSnapshot({query:sql=>db.query<{snapshot:unknown}>(sql)},controller.privateKey);
  await db.query('RESET ROLE');
  await db.query('SET LOCAL ROLE mnebyvpn_fi_dns_meter');
  server=await startFiMeterLoopbackServer(0,input=>handleFiMeterRequest(input,np,controller.privateKey,adapter));
  const hostname=label+'.fi.dns.mnebyvpn.site';
  await writeFile(join(root,'node.key'),node.privateKey.export({format:'der',type:'pkcs8'}),{mode:0o600});
  await writeFile(join(root,'controller.pub'),controller.publicKey.export({format:'der',type:'spki'}),{mode:0o600});
  await writeFile(join(root,'snapshot.json'),JSON.stringify(snapshot),{mode:0o600});
  await writeFile(join(root,'fixture.json'),JSON.stringify({port:(server.address() as AddressInfo).port,hostname}),{mode:0o600});
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=*.fi.dns.mnebyvpn.site','-addext','subjectAltName=DNS:*.fi.dns.mnebyvpn.site','-keyout',join(root,'privkey.pem'),'-out',join(root,'fullchain.pem')],{timeout:10000});
  const {stdout}=await exec('python3',['tests/ci/fi-dns-cross-repo-canary.py',root],{timeout:45000});
  assert.match(stdout,/FI_DOT_SIGNED_QUOTA_E2E_PASS/);
  await db.query('RESET ROLE');
  const {rows}=await db.query('SELECT used_queries::int AS used,reserved_queries::int AS held FROM personal_dns_query_windows WHERE entitlement_id=$1',[entitlement]);
  assert.deepEqual(rows,[{used:2,held:0}]);
 }finally{
  if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  try{await db.query('ROLLBACK');}finally{db.release();await pool.end();await rm(root,{recursive:true,force:true});}
 }
});
