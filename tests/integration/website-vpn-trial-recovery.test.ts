import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {rememberWebsiteVpnTrial,recoverWebsiteVpnTrials} from '../../packages/web/src/website-vpn-trial-recovery.ts';
const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
 user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
 database:process.env.PGDATABASE??'mnebyvpn_test',max:3});
after(async()=>pool.end());
test('website trial recovers without browser; mail only after final node ACK, retries then stops',async()=>{
 const account=randomUUID(), email='trial-'+account.slice(0,8)+'@example.org';
 const device=createHash('sha256').update(account).digest('hex');
 await pool.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
 await pool.query('INSERT INTO accounts(id,email_address) VALUES($1,$2)',[account,email]);
 await rememberWebsiteVpnTrial(pool,account,device);
 await rememberWebsiteVpnTrial(pool,account,device);
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
