/** Real Ed25519 + scoped PostgreSQL RPC, disposable DB only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,randomBytes,randomInt} from 'node:crypto';
import {Pool} from 'pg';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {AddressInfo,Server} from 'node:net';
import {startFiMeterLoopbackServer} from '../../packages/dns-policy/src/fi-dns-meter-loopback.ts';
import {buildFiDnsSnapshot} from '../../packages/dns-policy/src/fi-dns-snapshot-publisher.ts';
import {proposeRegionalPersonalDnsIdentity} from '../../packages/dns-policy/src/regional-personal-dot-identity.ts';
import {DEFAULT_DNS_QUERY_LIMIT_PER_30D} from '../../packages/dns-policy/src/personal-dot-identity.ts';
const exec=promisify(execFile);
import {handleFiMeterRequest,type MeterDatabase} from '../../packages/dns-policy/src/fi-dns-meter-rpc.ts';

const trial=process.env.FI_BUNDLE_TRIAL_E2E==='1';
test(trial?'German and Finnish trial profiles share 30000 successful answers':'independent German and Finnish profiles spend the same million-query PostgreSQL quota',async()=>{
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
 const telegramId=String(randomInt(8_900_000_000,9_000_000_000));
 const {label,hostname,tokenSha256:digest}=proposeRegionalPersonalDnsIdentity('FI');
 const de=proposeRegionalPersonalDnsIdentity('DE');
 const limit=trial?30_000:DEFAULT_DNS_QUERY_LIMIT_PER_30D;
 assert.equal(DEFAULT_DNS_QUERY_LIMIT_PER_30D,1_000_000);
 assert.notEqual(de.hostname,hostname);
 const root=await mkdtemp(join(tmpdir(),'fi-dns-e2e-'));
 const adapter:MeterDatabase={query:(sql,values)=>db.query<{result:unknown}>(sql,values)};
 let server:Server|undefined;
 try{
  await db.query('BEGIN');
  // The shared disposable CI database may already contain seeded FI grants.
  // Isolate the single-profile publisher input inside this rollback-only transaction.
  await db.query('UPDATE fi_dns_regional_credentials SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL');
  await db.query("INSERT INTO vpn_node_enrollment_inventory(node_id,endpoint_host,identity_public_spki) VALUES('fi-test-01','ci-meter-fi.example.org',$1)",[np.spki]);
  await db.query("UPDATE vpn_node_enrollment_inventory SET status='approved',approved_at=clock_timestamp() WHERE node_id='fi-test-01'");
  await db.query("INSERT INTO vpn_node_enrollment_challenges(challenge_id,node_id,nonce_sha256,issued_at,expires_at,consumed_at) VALUES($1,'fi-test-01',$2,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 minute',clock_timestamp())",[randomUUID(),randomBytes(32).toString('hex')]);
  await db.query("UPDATE vpn_node_enrollment_inventory SET status='enrolled',enrolled_at=clock_timestamp() WHERE node_id='fi-test-01'");
  await db.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',[account,telegramId]);
  if(trial){
   await db.query("INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) VALUES($1,$2,'bundle','internal_trial',0,'XTR','TRIAL')",[order,account]);
   await db.query("INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,quota_limit_bytes) VALUES($1,$2,$3,'smart_dns','ACTIVE',1,statement_timestamp()-interval '1 minute',statement_timestamp()-interval '1 minute'+interval '24 hours',1073741824)",[entitlement,account,order]);
   await db.query("INSERT INTO trial_grants(account_id,order_id,product,telegram_user_id,activated_at,access_expires_at) SELECT account_id,source_order_id,'bundle',$2,starts_at,expires_at FROM entitlements WHERE id=$1",[entitlement,telegramId]);
  }else{
   await db.query("INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) VALUES($1,$2,'smart_dns','fixture',20000,'RUB','PAID')",[order,account]);
   await db.query("INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,dns_query_quota_per_30d) VALUES($1,$2,$3,'smart_dns','ACTIVE',1,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',$4)",[entitlement,account,order,limit]);
  }
  assert.equal((await db.query('SELECT issue_personal_dns_credential($1,$2,$3,$4) AS result',[entitlement,de.label,de.tokenSha256,limit])).rows[0].result,'ISSUED');
  const issueFinnish=async(actor:string,country:string,token:string,revision:number)=>{
   const {rows}=await db.query('SELECT public.issue_regional_dns_credential($1,$2,$3,$4,$5) AS result',
     [actor,entitlement,country,token,revision]);
   return rows[0].result;
  };
  const telegramRevision=async(actor:string)=>{
   const {rows}=await db.query("SELECT public.telegram_regional_dns_revision($1,'FI') AS revision",[actor]);
   return rows[0].revision;
  };
  assert.equal(await telegramRevision(telegramId),null);
  await db.query('SET LOCAL ROLE mnebyvpn_regional_dns_issuer');
  assert.equal(await issueFinnish(randomUUID(),'FI',label,0),'DENY_OWNER');
  assert.equal(await issueFinnish(account,'SE',label,0),'DENY_REGION');
  assert.equal(await issueFinnish(account,'FI',label,0),'DENY_DISABLED');
  await db.query('RESET ROLE');
  // Start three queries from the ceiling so no load loop is needed.
  await db.query('INSERT INTO personal_dns_query_windows(entitlement_id,period_index,used_queries,reserved_queries) VALUES($1,0,$2,0)',[entitlement,limit-3]);
  const germanRequest=randomUUID();
  assert.equal((await db.query('SELECT reserve_personal_dns_query($1,$2) AS result',[de.label,germanRequest])).rows[0].result,'RESERVED');
  assert.equal((await db.query('SELECT finish_personal_dns_query($1,true) AS result',[germanRequest])).rows[0].result,'SETTLED');
  await db.query('UPDATE fi_dns_meter_gate SET enabled=true');
  assert.equal(await telegramRevision(telegramId),'0');
  await db.query('SET LOCAL ROLE mnebyvpn_regional_dns_issuer');
  const retired=proposeRegionalPersonalDnsIdentity('FI').label;
  assert.equal(await issueFinnish(account,'FI',retired,0),'ISSUED');
  assert.equal(await issueFinnish(account,'FI',label,0),'DENY_STALE');
  await db.query('RESET ROLE');
  const {rows:telegramIssue}=await db.query("SELECT public.telegram_issue_regional_dns_credential($1,'FI',$2,1) AS result",
    [telegramId,label]);
  assert.equal(telegramIssue[0].result,'ROTATED');
  assert.equal(await telegramRevision(telegramId),'2');

  await db.query('SET LOCAL ROLE mnebyvpn_fi_dns_publisher');
  const snapshot=await buildFiDnsSnapshot({query:sql=>db.query<{snapshot:unknown}>(sql)},controller.privateKey);
  assert.equal(snapshot.grants.length,1,'expected one synthetic regional grant');
  assert.ok(snapshot.grants[0].tokenSha256===digest,'published digest differs from the regional profile');
  assert.equal(snapshot.grants[0].state,trial?'ACTIVE_TRIAL':'ACTIVE');
  await db.query('RESET ROLE');
  await db.query('SET LOCAL ROLE mnebyvpn_fi_dns_meter');
  server=await startFiMeterLoopbackServer(0,input=>handleFiMeterRequest(input,np,controller.privateKey,adapter));
  await writeFile(join(root,'node.key'),node.privateKey.export({format:'der',type:'pkcs8'}),{mode:0o600});
  await writeFile(join(root,'controller.pub'),controller.publicKey.export({format:'der',type:'spki'}),{mode:0o600});
  await writeFile(join(root,'snapshot.json'),JSON.stringify(snapshot),{mode:0o600});
  await writeFile(join(root,'fixture.json'),JSON.stringify({port:(server.address() as AddressInfo).port,hostname,trial}),{mode:0o600});
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=*.fi.mnebyvpn.site','-addext','subjectAltName=DNS:*.fi.mnebyvpn.site','-keyout',join(root,'privkey.pem'),'-out',join(root,'fullchain.pem')],{timeout:10000});
  const {stdout}=await exec('python3',[trial?'tests/ci/fi-dns-trial-cross-repo-canary.py':'tests/ci/fi-dns-cross-repo-canary.py',root],{timeout:45000});
  assert.match(stdout,trial?/FI_DOT_TRIAL_SHARED_QUOTA_E2E_PASS/:/FI_DOT_PILOT_SIGNED_QUOTA_AND_REVOKE_E2E_PASS/);
  await db.query('RESET ROLE');
  const {rows}=await db.query('SELECT used_queries::int AS used,reserved_queries::int AS held FROM personal_dns_query_windows WHERE entitlement_id=$1',[entitlement]);
  assert.deepEqual(rows,[{used:limit,held:0}]);
  assert.equal((await db.query('SELECT reserve_personal_dns_query($1,$2) AS result',[de.label,randomUUID()])).rows[0].result,'DENY_QUOTA');
 }finally{
  if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  try{await db.query('ROLLBACK');}finally{db.release();await pool.end();await rm(root,{recursive:true,force:true});}
 }
});
