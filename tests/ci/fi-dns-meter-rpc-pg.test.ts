/** Real Ed25519 + scoped PostgreSQL RPC, disposable DB only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {handleFiMeterRequest,signFiMeterRequest,verifyFiMeterDecision,type MeterRequest,type MeterDatabase} from '../../packages/dns-policy/src/fi-dns-meter-rpc.ts';

test('authenticated FI controller reserves and settles through its restricted database role',async()=>{
 assert.equal(process.env.PGDATABASE,'mnebyvpn_test');
 const pool=new Pool({max:1,connectionTimeoutMillis:2500});
 const db=await pool.connect();
 const node=generateKeyPairSync('ed25519'),controller=generateKeyPairSync('ed25519');
 const pin=(key:typeof node.publicKey)=>{
  const der=key.export({format:'der',type:'spki'});
  return {spki:der.toString('base64url'),sha256:createHash('sha256').update(der).digest('hex')};
 };
 const np=pin(node.publicKey),cp=pin(controller.publicKey);
 const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
 const label=randomBytes(6).toString('hex');
 const legacyDigest=createHash('sha256').update(label).digest('hex');
 const digest=createHash('sha256').update('MNEBYVPN_COUNTRY_DNS_V1\0FI\0'+label,'ascii').digest('hex');
 const requestId=randomUUID();
 const make=(op:MeterRequest['op']):MeterRequest=>({
  version:1,nodeId:'fi-test-01',countryCode:'FI',op,requestId,
  tokenSha256:op==='reserve'?digest:null,issuedAt:new Date().toISOString(),
  nonce:randomBytes(32).toString('hex'),
 });
 const adapter:MeterDatabase={query:(sql,values)=>db.query<{result:unknown}>(sql,values)};
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
  await db.query('SET LOCAL ROLE mnebyvpn_fi_dns_meter');
  const req=make('reserve'),signed=signFiMeterRequest(req,node.privateKey);
  const invoke=async(r:MeterRequest,s=signFiMeterRequest(r,node.privateKey))=>
    verifyFiMeterDecision(await handleFiMeterRequest(s,np,controller.privateKey,adapter),r,cp).result;
  assert.equal(await invoke(req,signed),'RESERVED');
  assert.equal(await invoke(req,signed),'DENY_REPLAY');
  assert.equal(await invoke(make('settle')),'SETTLED');
  assert.equal(await invoke(make('release')),'SETTLED');
  await db.query('RESET ROLE');
  const {rows}=await db.query('SELECT used_queries::int AS used,reserved_queries::int AS held FROM personal_dns_query_windows WHERE entitlement_id=$1',[entitlement]);
  assert.deepEqual(rows,[{used:1,held:0}]);
 }finally{
  try{await db.query('ROLLBACK');}finally{db.release();await pool.end();}
 }
});
