import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {rememberWebsiteVpnTrial,recoverWebsiteVpnTrials,websiteVpnTrialStatus} from '../../packages/web/src/website-vpn-trial-recovery.ts';
const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
 user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
 database:process.env.PGDATABASE??'mnebyvpn_test',max:3});
after(async()=>pool.end());
test('website trial recovers without browser; mail only after final node ACK, retries then stops',async()=>{
 const account=randomUUID(), email='trial-'+account.slice(0,8)+'@example.org';
 const device=createHash('sha256').update(account).digest('hex');
 await pool.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
 await pool.query('INSERT INTO accounts(id,email_address) VALUES($1,$2)',[account,email]);
 assert.equal(await websiteVpnTrialStatus(pool,account),'NONE');
 await rememberWebsiteVpnTrial(pool,account,device);
 await rememberWebsiteVpnTrial(pool,account,device);
 assert.equal(await websiteVpnTrialStatus(pool,account),'PENDING');
 assert.equal(await websiteVpnTrialStatus(pool,randomUUID()),'NONE');
 const store=new PgBillingStore(pool);
 const sent:string[]=[];
 let mailWorks=false;
 const send=async(to:string,_expiry:Date,_secret:string)=>{sent.push(to);return mailWorks;};
 const run=()=>recoverWebsiteVpnTrials(pool,store,'test-only-secret',send);
 const due=()=>pool.query('UPDATE website_vpn_trial_requests SET next_attempt_at=clock_timestamp() WHERE account_id=$1',[account]);
 await run();
 assert.equal(sent.filter(x=>x===email).length,0);
 const r=await pool.query('SELECT order_id,status FROM website_vpn_trial_requests WHERE account_id=$1',[account]);
 assert.equal(r.rows[0].status,'WAITING');
 assert.equal(await websiteVpnTrialStatus(pool,account),'WAITING');
 const order=r.rows[0].order_id;
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM trial_grants WHERE account_id=$1',[account])).rows[0].n,1);
 const entitlement=(await pool.query("SELECT id FROM entitlements WHERE source_order_id=$1 AND product='vpn'",[order])).rows[0].id;
 const fence=(await pool.query("SELECT claim_provisioning_fence($1,'vpn') AS fence",[entitlement])).rows[0].fence;
 assert.equal((await pool.query("SELECT acknowledge_provisioning($1,'vpn',1,$2,true) AS ok",[entitlement,fence])).rows[0].ok,true);
 await due();await run();
 assert.equal(sent.filter(x=>x===email).length,0,'initial ACK is not final 24h readiness');
 assert.equal((await pool.query("SELECT acknowledge_provisioning($1,'vpn',2,$2,true) AS ok",[entitlement,fence])).rows[0].ok,true);
 await due();await run();
 assert.equal(sent.filter(x=>x===email).length,1);
 assert.equal((await pool.query('SELECT status FROM website_vpn_trial_requests WHERE account_id=$1',[account])).rows[0].status,'WAITING');
 mailWorks=true;
 await due();await run();
 assert.equal(sent.filter(x=>x===email).length,2);
 assert.equal((await pool.query('SELECT status FROM website_vpn_trial_requests WHERE account_id=$1',[account])).rows[0].status,'SENT');
 assert.equal(await websiteVpnTrialStatus(pool,account),'SENT');
 await due();await run();
 assert.equal(sent.filter(x=>x===email).length,2);
});

test('website billing role can create and recover an authenticated trial without unrestricted account writes',async()=>{
 const client=await pool.connect();
 let roleCreated=false;
 const account=randomUUID(),email='role-trial-'+account.slice(0,8)+'@example.org';
 const device=createHash('sha256').update(account).digest('hex');
 try{
  // The integration workflow uses only disposable PostgreSQL. Never alter
  // or reuse an existing role from an external database.
  assert.equal(process.env.PGDATABASE??'mnebyvpn_test','mnebyvpn_test');
  const existing=await client.query("SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_pay'");
  assert.equal(existing.rowCount,0);
  await client.query('CREATE ROLE mnebyvpn_site_pay NOLOGIN');
  roleCreated=true;
  // Mirror the relevant existing infra site-pay grants. The migration must
  // supply the trial-specific permissions missing from this baseline.
  await client.query(`GRANT USAGE ON SCHEMA public TO mnebyvpn_site_pay;
    GRANT SELECT ON accounts,billing_plans,trial_offers,referral_invites,provisioning_state TO mnebyvpn_site_pay;
    GRANT UPDATE(created_at) ON accounts TO mnebyvpn_site_pay;
    GRANT UPDATE(title) ON billing_plans TO mnebyvpn_site_pay;
    GRANT SELECT,INSERT ON orders,reconcile_outbox TO mnebyvpn_site_pay;
    GRANT UPDATE(state) ON orders TO mnebyvpn_site_pay;
    GRANT SELECT,INSERT,UPDATE ON entitlements TO mnebyvpn_site_pay;
    GRANT SELECT ON trial_grants TO mnebyvpn_site_pay;`);
  const migration=await readFile(new URL('../../db/migrations/0153_website_vpn_trial_recovery.sql',import.meta.url),'utf8');
  const grants=migration.slice(migration.indexOf('DO $$'),migration.lastIndexOf('COMMIT;'));
  assert.ok(grants.startsWith('DO $$'));
  await client.query(grants);
  await client.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
  await client.query('INSERT INTO accounts(id,email_address) VALUES($1,$2)',[account,email]);
  await client.query('SET ROLE mnebyvpn_site_pay');
  const scoped={query:client.query.bind(client),
    connect:async()=>({query:client.query.bind(client),release:()=>{}})} as unknown as Pool;
  assert.equal(await rememberWebsiteVpnTrial(scoped,account,device),true);
  const result=await new PgBillingStore(scoped).grantTrial(account,'vpn',undefined,device);
  assert.equal(result.status,'GRANTED');
  assert.equal((await client.query("SELECT has_column_privilege('accounts','email_address','UPDATE') AS allowed")).rows[0].allowed,false);
  await recoverWebsiteVpnTrials(scoped,new PgBillingStore(scoped),'test-only-secret',async()=>{throw Error('Must not send before ACK');});
  const request=await client.query('SELECT status,order_id FROM website_vpn_trial_requests WHERE account_id=$1',[account]);
  assert.equal(request.rows[0].status,'WAITING');
  assert.equal(request.rows[0].order_id,result.orderId);
 }finally{
  await client.query('RESET ROLE');
  if(roleCreated){
    await client.query('DROP OWNED BY mnebyvpn_site_pay');
    await client.query('DROP ROLE mnebyvpn_site_pay');
  }
  client.release();
 }
});

test('historical verified email cohort gets one real trial and mail only after final ACK',async()=>{
 const account=randomUUID(),email='legacy-auto-'+account.slice(0,8)+'@example.org';
 const recent=randomUUID(),already=randomUUID(),unverified=randomUUID();
 const migration=await readFile(new URL('../../db/migrations/0155_legacy_email_trial_backfill.sql',import.meta.url),'utf8');
 const seed=migration.slice(migration.indexOf('INSERT INTO website_vpn_trial_requests'),migration.lastIndexOf('COMMIT;'));
 assert.ok(seed.startsWith('INSERT INTO'));
 const c=await pool.connect();
 try{
  await c.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
  await c.query("INSERT INTO accounts(id,email_address,created_at) VALUES($1,$2,'2026-11-24T00:00:00Z'),($3,$4,clock_timestamp()+interval '1 day'),($5,$6,'2026-11-24T00:00:00Z'),($7,NULL,'2026-11-24T00:00:00Z')",
    [account,email,recent,'recent-'+recent.slice(0,8)+'@example.org',already,'used-'+already.slice(0,8)+'@example.org',unverified]);
  const store=new PgBillingStore(pool);
  assert.equal((await store.grantTrial(already,'vpn')).status,'GRANTED');
  // Exercise the actual migration statement against only these synthetic fixtures.
  const scopedSeed=seed.replace('WHERE a.email_address IS NOT NULL','WHERE a.id=ANY($1::uuid[]) AND a.email_address IS NOT NULL');
  await c.query(scopedSeed,[[account,recent,already,unverified]]);
  await c.query(scopedSeed,[[account,recent,already,unverified]]);
  const selected=await c.query('SELECT account_id,request_source,device_hash FROM website_vpn_trial_requests WHERE account_id=ANY($1::uuid[])',[[account,recent,already,unverified]]);
  assert.deepEqual(selected.rows,[{account_id:account,request_source:'LEGACY_EMAIL',device_hash:null}]);
  const sent:string[]=[];
  const send=async(to:string)=>{sent.push(to);return true;};
  const run=()=>recoverWebsiteVpnTrials(pool,store,'test-only-secret',send);
  const due=()=>pool.query('UPDATE website_vpn_trial_requests SET next_attempt_at=clock_timestamp() WHERE account_id=$1',[account]);
  await run();
  assert.equal(sent.includes(email),false);
  const order=(await c.query('SELECT order_id FROM website_vpn_trial_requests WHERE account_id=$1',[account])).rows[0].order_id;
  assert.ok(order);
  const eid=(await c.query("SELECT id FROM entitlements WHERE source_order_id=$1 AND product='vpn'",[order])).rows[0].id;
  const fence=(await c.query("SELECT claim_provisioning_fence($1,'vpn') AS fence",[eid])).rows[0].fence;
  await c.query("SELECT acknowledge_provisioning($1,'vpn',1,$2,true)",[eid,fence]);
  await due();await run();assert.equal(sent.includes(email),false);
  await c.query("SELECT acknowledge_provisioning($1,'vpn',2,$2,true)",[eid,fence]);
  await due();await run();assert.equal(sent.filter(x=>x===email).length,1);
  await due();await run();assert.equal(sent.filter(x=>x===email).length,1);
  assert.equal(await websiteVpnTrialStatus(pool,account),'SENT');
  assert.equal((await c.query('SELECT count(*)::int AS n FROM trial_grants WHERE account_id=$1',[account])).rows[0].n,1);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM trial_device_claims WHERE account_id=$1',[account])).rows[0].n,0);
 }finally{c.release();}
});

test('legacy recovery rechecks eligibility inside grant and resumes a committed grant after a crash',async()=>{
 const rejected=randomUUID(),resumed=randomUUID(),notQueued=randomUUID();
 const store=new PgBillingStore(pool);
 await pool.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
 for(const id of [rejected,resumed,notQueued]){
   await pool.query('INSERT INTO accounts(id,email_address) VALUES($1,$2)',[id,'review-'+id.slice(0,8)+'@example.org']);
 }
 await assert.rejects(store.grantTrial(notQueued,'vpn',undefined,undefined,true),/Legacy email trial no longer eligible/);
 await pool.query("INSERT INTO website_vpn_trial_requests(account_id,device_hash,request_source) VALUES($1,NULL,'LEGACY_EMAIL'),($2,NULL,'LEGACY_EMAIL')",[rejected,resumed]);
 await pool.query("INSERT INTO trial_device_claims(device_hash,account_id) VALUES($1,$2)",[createHash('sha256').update(rejected).digest('hex'),rejected]);
 await assert.rejects(store.grantTrial(rejected,'vpn',undefined,undefined,true),/Legacy email trial no longer eligible/);
 const first=await store.grantTrial(resumed,'vpn',undefined,undefined,true);
 assert.equal(first.status,'GRANTED');
 // Simulate restart after the grant committed but before the queue was advanced.
 // A later unrelated order must not cause the original successful grant to be lost.
 const paid=randomUUID();
 await pool.query("INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) VALUES($1,$2,'vpn','manual_sale',10000,'RUB','PAID')",[paid,resumed]);
 await pool.query("INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at) VALUES($1,$2,$3,'vpn','PAID_PENDING_PROVISIONING',1,clock_timestamp(),clock_timestamp()+interval '1 day')",[randomUUID(),resumed,paid]);
 const second=await store.grantTrial(resumed,'vpn',undefined,undefined,true);
 assert.equal(second.orderId,first.orderId);
 await recoverWebsiteVpnTrials(pool,store,'test-only-secret',async()=>{throw Error('Must not mail before activation');});
 const result=await pool.query('SELECT account_id,status,order_id,last_error_code FROM website_vpn_trial_requests WHERE account_id=ANY($1::uuid[])',[[rejected,resumed]]);
 const bad=result.rows.find(r=>r.account_id===rejected),good=result.rows.find(r=>r.account_id===resumed);
 assert.equal(bad?.status,'REJECTED');assert.equal(bad?.last_error_code,'LEGACY_NO_LONGER_ELIGIBLE');
 assert.equal(good?.status,'WAITING');assert.equal(good?.order_id,first.orderId);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM trial_grants WHERE account_id=$1',[resumed])).rows[0].n,1);
});

test('website bundle recovery waits for both final service revisions and keeps one grant',async()=>{
 const account=randomUUID(),email='bundle-'+account.slice(0,8)+'@example.org';
 const device=createHash('sha256').update(account).digest('hex');
 await pool.query("UPDATE trial_offers SET enabled=true,dns_quota_bytes=1073741824 WHERE product='bundle'");
 await pool.query('INSERT INTO accounts(id,email_address) VALUES($1,$2)',[account,email]);
 await rememberWebsiteVpnTrial(pool,account,device);
 const store=new PgBillingStore(pool);
 const sent:string[]=[];
 const run=()=>recoverWebsiteVpnTrials(pool,store,'test-only-secret',async(to)=>{sent.push(to);return true;},'bundle');
 const due=()=>pool.query('UPDATE website_vpn_trial_requests SET next_attempt_at=clock_timestamp() WHERE account_id=$1',[account]);
 await run();
 const row=(await pool.query('SELECT order_id,status FROM website_vpn_trial_requests WHERE account_id=$1',[account])).rows[0];
 assert.equal(row.status,'WAITING');
 const order=row.order_id;
 const {rows}=await pool.query('SELECT id,product FROM entitlements WHERE source_order_id=$1',[order]);
 assert.deepEqual(rows.map(x=>x.product).sort(),['smart_dns','vpn']);
 const ack=async(product:string,revision:number,provisional:boolean)=>{
   const e=rows.find(x=>x.product===product);
   const f=(await pool.query("SELECT claim_provisioning_fence($1,$2) AS fence",[e.id,product])).rows[0].fence;
   return (await pool.query("SELECT acknowledge_provisioning_observed($1,$2,$3,$4,true,CASE WHEN $5::boolean THEN clock_timestamp()+interval '4 minutes' ELSE NULL END) AS ok",[e.id,product,revision,f,provisional])).rows[0].ok;
 };
 assert.equal(await ack('vpn',1,true),true);
 assert.equal(await ack('smart_dns',1,true),true);
 assert.equal(await ack('vpn',2,false),true);
 await due();await run();
 assert.equal(sent.filter(x=>x===email).length,0);
 assert.equal(await ack('smart_dns',2,false),true);
 await due();await run();
 assert.equal(sent.filter(x=>x===email).length,1);
 assert.equal(await websiteVpnTrialStatus(pool,account),'SENT');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM trial_grants WHERE account_id=$1',[account])).rows[0].n,1);
 await due();await run();
 assert.equal(sent.filter(x=>x===email).length,1);
});
