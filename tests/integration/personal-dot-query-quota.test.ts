import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {makePersonalDoTIdentity} from '../../packages/dns-policy/src/personal-dot-identity.ts';

const pool=new Pool({
  host:process.env.PGHOST??'localhost',
  port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',
  password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
  max:15,
});
const accountId=randomUUID(),orderId=randomUUID(),entitlementId=randomUUID();
const accountId2=randomUUID(),orderId2=randomUUID(),entitlementId2=randomUUID();
const credential=makePersonalDoTIdentity(undefined,new Uint8Array(16).fill(31));
const credential2=makePersonalDoTIdentity(undefined,new Uint8Array(16).fill(47));
const rotatedCredential=makePersonalDoTIdentity(undefined,new Uint8Array(16).fill(63));

before(async()=>{
  await pool.query('INSERT INTO accounts(id) VALUES($1),($2)',[accountId,accountId2]);
  await pool.query(`INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
    VALUES($1,$2,'smart_dns','fixture',20000,'RUB','PAID'),
          ($3,$4,'smart_dns','fixture',20000,'RUB','PAID')`,
    [orderId,accountId,orderId2,accountId2]);
  await pool.query(`INSERT INTO entitlements(
    id,account_id,source_order_id,product,state,revision,
    starts_at,expires_at,quota_limit_bytes
  )VALUES($1,$2,$3,'smart_dns','ACTIVE',1,clock_timestamp()-interval '5 minutes',
           clock_timestamp()+interval '35 days',10000000),
          ($4,$5,$6,'smart_dns','ACTIVE',1,clock_timestamp()-interval '5 minutes',
           clock_timestamp()+interval '35 days',10000000)`,
    [entitlementId,accountId,orderId,entitlementId2,accountId2,orderId2]);
  for(const [id,ident,limit] of [[entitlementId,credential,5],[entitlementId2,credential2,3]] as const){
    const {rows}=await pool.query(
      'SELECT issue_personal_dns_credential($1,$2,$3,$4) AS result',
      [id,ident.label,ident.tokenSha256,limit],
    );
    assert.equal(rows[0].result,'ISSUED');
  }
});
after(async()=>{await pool.end()});

test('concurrent connections cannot exceed one subscriber query quota',async()=>{
  const results=await Promise.all(
    Array.from({length:30},()=>pool.query(
      'SELECT consume_personal_dns_query($1) AS result',[credential.label],
    )),
  );
  const outcomes=results.map(x=>x.rows[0].result);
  assert.equal(outcomes.filter(x=>x==='ALLOWED').length,5);
  assert.equal(outcomes.filter(x=>x==='DENY_QUOTA').length,25);
  const {rows}=await pool.query(
    'SELECT used_queries FROM personal_dns_query_windows WHERE entitlement_id=$1',
    [entitlementId],
  );
  assert.equal(rows.length,1);
  assert.equal(BigInt(rows[0].used_queries),5n);
});

test('separate personal hostname has independent quota',async()=>{
  for(let i=0;i<3;i++){
    const {rows}=await pool.query(
      'SELECT consume_personal_dns_query($1) AS result',
      [credential2.label],
    );
    assert.equal(rows[0].result,'ALLOWED');
  }
  const {rows}=await pool.query(
    'SELECT consume_personal_dns_query($1) AS result',
    [credential2.label],
  );
  assert.equal(rows[0].result,'DENY_QUOTA');
});

test('paid renewal does not erase used queries in the same 30-day interval',async()=>{
  await pool.query(
    "UPDATE entitlements SET expires_at=expires_at+interval '30 days' WHERE id=$1",
    [entitlementId],
  );
  const {rows}=await pool.query(
    'SELECT consume_personal_dns_query($1) AS result',
    [credential.label],
  );
  assert.equal(rows[0].result,'DENY_QUOTA');
});

test('rotation instantly invalidates old hostname without resetting paid quota',async()=>{
  const result=await pool.query(
    'SELECT rotate_personal_dns_credential($1,$2,$3,$4) AS result',
    [entitlementId,1,rotatedCredential.label,rotatedCredential.tokenSha256],
  );
  assert.equal(result.rows[0].result,'ROTATED');
  const stale=await pool.query(
    'SELECT rotate_personal_dns_credential($1,$2,$3,$4) AS result',
    [entitlementId,1,credential.label,credential.tokenSha256],
  );
  assert.equal(stale.rows[0].result,'DENY_STALE');
  const old=await pool.query(
    'SELECT consume_personal_dns_query($1) AS result',[credential.label],
  );
  assert.equal(old.rows[0].result,'DENY_UNKNOWN');
  const next=await pool.query(
    'SELECT consume_personal_dns_query($1) AS result',[rotatedCredential.label],
  );
  assert.equal(next.rows[0].result,'DENY_QUOTA');
  const status=await pool.query(
    'SELECT * FROM personal_dns_query_status($1)',[entitlementId],
  );
  assert.equal(BigInt(status.rows[0].credential_revision),2n);
  assert.equal(BigInt(status.rows[0].used_queries),5n);
});

test('revoked and expired grants can no longer consume queries',async()=>{
  const r=await pool.query('SELECT revoke_personal_dns_credential($1) AS ok',[entitlementId]);
  assert.equal(r.rows[0].ok,true);
  const d=await pool.query('SELECT consume_personal_dns_query($1) AS result',[rotatedCredential.label]);
  assert.equal(d.rows[0].result,'DENY_INACTIVE');
  await pool.query('UPDATE entitlements SET state=$2 WHERE id=$1',[entitlementId2,'EXPIRED']);
  const v=await pool.query('SELECT consume_personal_dns_query($1) AS result',[credential2.label]);
  assert.equal(v.rows[0].result,'DENY_INACTIVE');
});
