/** Mixed FI/legacy races in disposable PostgreSQL only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';

test('FI and legacy requests cannot overspend one DNS entitlement',async()=>{
  assert.equal(process.env.PGDATABASE,'mnebyvpn_test');
  const db=new Pool({max:8,connectionTimeoutMillis:2500});
  const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
  const label=randomBytes(6).toString('hex');
  const legacyDigest=createHash('sha256').update(label).digest('hex');
  const digest=createHash('sha256').update('MNEBYVPN_COUNTRY_DNS_V1\0FI\0'+label,'ascii').digest('hex');
  const fi=async(op:string,id:string,token:string|null=null)=>
    String((await db.query('SELECT public.fi_dns_meter_apply($1,$2::uuid,$3) AS result',[op,id,token])).rows[0].result);
  const legacy=async(id:string)=>
    String((await db.query('SELECT public.reserve_personal_dns_query($1,$2::uuid) AS result',[label,id])).rows[0].result);
  try {
    await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
    await db.query("INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) VALUES($1,$2,'smart_dns','fixture',20000,'RUB','PAID')",[order,account]);
    await db.query("INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at,dns_query_quota_per_30d) VALUES($1,$2,$3,'smart_dns','ACTIVE',1,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',2)",[entitlement,account,order]);
    assert.equal((await db.query('SELECT issue_personal_dns_credential($1,$2,$3,2) AS result',[entitlement,label,legacyDigest])).rows[0].result,'ISSUED');
    await db.query('INSERT INTO fi_dns_regional_credentials(entitlement_id,token_sha256,credential_revision) VALUES($1,$2,1)',[entitlement,digest]);
    await db.query('UPDATE fi_dns_meter_gate SET enabled=true');
    const requests=Array.from({length:8},(_,i)=>({id:randomUUID(),fi:i%2===0}));
    const results=await Promise.all(requests.map(async q=>({...q,status:await (q.fi?fi('reserve',q.id,digest):legacy(q.id))})));
    assert.equal(results.filter(q=>q.status==='RESERVED').length,2);
    assert.equal(results.filter(q=>q.status==='DENY_QUOTA').length,6);
    for(const q of results.filter(q=>q.status==='RESERVED')){
      const status=q.fi?await fi('settle',q.id):String((await db.query('SELECT finish_personal_dns_query($1,true) AS result',[q.id])).rows[0].result);
      assert.equal(status,'SETTLED');
    }
    const {rows}=await db.query('SELECT used_queries::int AS used,reserved_queries::int AS held FROM personal_dns_query_windows WHERE entitlement_id=$1',[entitlement]);
    assert.deepEqual(rows,[{used:2,held:0}]);
    assert.equal(await fi('reserve',randomUUID(),digest),'DENY_QUOTA');
    assert.equal(await legacy(randomUUID()),'DENY_QUOTA');
  } finally {
    await db.query('UPDATE fi_dns_meter_gate SET enabled=false');
    await db.end();
  }
});
