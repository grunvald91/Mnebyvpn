import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {issueSubscriptionLinkForAccount} from '../../packages/provisioning/src/subscription-links.ts';

test('canonical auth role mints owned links while public reader remains read-only',async()=>{
 const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
   user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
   database:process.env.PGDATABASE??'mnebyvpn_test',max:1});
 const client=await pool.connect();
 const scoped={query:client.query.bind(client)} as Pool;
 const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
 try{
  await client.query('BEGIN');
  await client.query('CREATE ROLE mnebyvpn_site_auth NOLOGIN; CREATE ROLE mnebyvpn_site_pay NOLOGIN; CREATE ROLE mnebyvpn_sub_ro NOLOGIN');
  await client.query('GRANT USAGE ON SCHEMA public TO mnebyvpn_site_auth,mnebyvpn_site_pay,mnebyvpn_sub_ro');
  await client.query('GRANT SELECT ON accounts,entitlements TO mnebyvpn_site_auth');
  await client.query('GRANT SELECT ON accounts,entitlements,provisioning_state,vpn_subscription_links TO mnebyvpn_sub_ro');
  const migration=await readFile(new URL('../../db/migrations/0103_website_subscription_permissions.sql',import.meta.url),'utf8');
  // Keep this role fixture rollback-only; execute the actual migration body.
  await client.query(migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
  await client.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  await client.query("INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')",[order,account]);
  await client.query("INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at) VALUES($1,$2,$3,'vpn','ACTIVE',2,now(),now()+interval '1 day')",[entitlement,account,order]);
  await client.query("INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,last_observed_at) VALUES($1,'vpn',2,now())",[entitlement]);
  await client.query('SET LOCAL ROLE mnebyvpn_sub_ro');
  await client.query('SAVEPOINT read_only');
  await assert.rejects(issueSubscriptionLinkForAccount(scoped,account,entitlement),{code:'42501'});
  await client.query('ROLLBACK TO SAVEPOINT read_only');
  await client.query('RESET ROLE');
  await client.query('SET LOCAL ROLE mnebyvpn_site_auth');
  assert.equal((await issueSubscriptionLinkForAccount(scoped,account,entitlement))?.entitlementId,entitlement);
  assert.equal(await issueSubscriptionLinkForAccount(scoped,randomUUID(),entitlement),null);
  const rights=await client.query("SELECT has_table_privilege('entitlements','UPDATE') AS entitlement_write,has_table_privilege('orders','INSERT') AS order_write");
  assert.equal(rights.rows[0].entitlement_write,false);
  assert.equal(rights.rows[0].order_write,false);
  await client.query('RESET ROLE');
  assert.equal((await client.query("SELECT has_table_privilege('mnebyvpn_site_pay','trial_grants','SELECT') AS ok")).rows[0].ok,true);
 }finally{await client.query('ROLLBACK');client.release();await pool.end();}
});
