import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {issueTelegramPersonalDns,rotateTelegramPersonalDns,telegramPersonalDnsSummary}
  from '../../packages/dns-policy/src/personal-dot-telegram.ts';

const db=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:5,
});
const owner=432188721,other=432188722;
const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
before(async()=>{
  await db.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',
    [account,String(owner)]);
  await db.query(`INSERT INTO orders(id,account_id,product,provider,
    amount_minor,currency,state) VALUES($1,$2,'smart_dns','telegram_stars',200,'XTR','PAID')`,
    [order,account]);
  await db.query(`INSERT INTO entitlements(id,account_id,source_order_id,
    product,state,revision,starts_at,expires_at,quota_limit_bytes)
    VALUES($1,$2,$3,'smart_dns','ACTIVE',1,clock_timestamp()-interval '1 hour',
      clock_timestamp()+interval '30 days',10000000)`,
    [entitlement,account,order]);
});
after(async()=>db.end());

test('another Telegram account cannot see or issue this customer DNS hostname',async()=>{
  assert.equal(await telegramPersonalDnsSummary(db,other),null);
  assert.deepEqual(await issueTelegramPersonalDns(db,other),{kind:'not-active'});
  assert.deepEqual(await rotateTelegramPersonalDns(db,other,1),{kind:'not-active'});
});

test('owner receives one bearer; no plaintext in SQL; 1M query allowance',async()=>{
  const a=await issueTelegramPersonalDns(db,owner);
  assert.equal(a.kind,'issued');
  if(a.kind!=='issued')return;
  assert.match(a.hostname,/^[a-z0-9]{12}\.dns\.mnebyvpn\.site$/);
  assert.equal(a.credentialRevision,1);
  assert.deepEqual(await issueTelegramPersonalDns(db,owner),{kind:'already-issued'});
  const {rows}=await db.query(
    'SELECT token_sha256,query_limit_per_30d FROM personal_dns_credentials WHERE entitlement_id=$1',
    [entitlement]);
  assert.equal(rows.length,1);
  assert.equal(String(rows[0].token_sha256).length,64);
  assert.equal(String(rows[0].token_sha256).includes(a.hostname.slice(0,12)),false);
  assert.equal(BigInt(rows[0].query_limit_per_30d),1000000n);
  const summary=await telegramPersonalDnsSummary(db,owner);
  assert.equal(summary?.credentialIssued,true);
  assert.equal(summary?.credentialRevision,1);
  assert.equal(summary?.queryLimit,'1000000');
  assert.equal(summary?.queryRemaining,'1000000');
  assert.equal(summary?.queryUsed,'0');
});

test('rotation is owner-only, consumes revision once and does not reset usage',async()=>{
  const {rows}=await db.query('SELECT token_sha256 FROM personal_dns_credentials WHERE entitlement_id=$1',
    [entitlement]);
  const beforeHash=String(rows[0].token_sha256);
  const rotated=await rotateTelegramPersonalDns(db,owner,1);
  assert.equal(rotated.kind,'rotated');
  if(rotated.kind!=='rotated')return;
  assert.equal(rotated.credentialRevision,2);
  assert.match(rotated.hostname,/^[a-z0-9]{12}\.dns\.mnebyvpn\.site$/);
  assert.deepEqual(await rotateTelegramPersonalDns(db,owner,1),{kind:'stale'});
  const now=await db.query('SELECT token_sha256 FROM personal_dns_credentials WHERE entitlement_id=$1',
    [entitlement]);
  assert.notEqual(now.rows[0].token_sha256,beforeHash);
  const label=rotated.hostname.split('.')[0];
  const reserve=await db.query('SELECT reserve_personal_dns_query($1,$2) AS result',
    [label,randomUUID()]);
  assert.equal(reserve.rows[0].result,'RESERVED');
  const summary=await telegramPersonalDnsSummary(db,owner);
  assert.equal(summary?.credentialRevision,2);
  assert.equal(summary?.queryRemaining,'999999');
});

test('expiry is direct-only; refund revokes even ordinary DNS',async()=>{
  const fresh=await rotateTelegramPersonalDns(db,owner,2);
  assert.equal(fresh.kind,'rotated');
  if(fresh.kind!=='rotated')return;
  const label=fresh.hostname.split('.')[0];
  await db.query(`UPDATE entitlements SET state='EXPIRED',
    starts_at=clock_timestamp()-interval '160 days',
    expires_at=clock_timestamp()-interval '100 days'
    WHERE id=$1`,[entitlement]);
  assert.equal((await db.query('SELECT recognize_personal_dns_credential($1) AS ok',
    [label])).rows[0].ok,true);
  assert.deepEqual(await issueTelegramPersonalDns(db,owner),{kind:'not-active'});
  await db.query(`UPDATE entitlements SET state='REFUNDED' WHERE id=$1`,[entitlement]);
  assert.equal((await db.query('SELECT recognize_personal_dns_credential($1) AS ok',
    [label])).rows[0].ok,false);
});
