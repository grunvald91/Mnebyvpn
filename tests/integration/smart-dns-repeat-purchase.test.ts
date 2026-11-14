import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {telegramPersonalDnsSummary,issueTelegramPersonalDns}
  from '../../packages/dns-policy/src/personal-dot-telegram.ts';

test('a new activated Smart DNS purchase wins over an older longer and exhausted package',async()=>{
  const pool=new Pool({
    host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
    user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
    database:process.env.PGDATABASE??'mnebyvpn_test',max:2,
  });
  const uid=7911023401,account=randomUUID();
  const oldOrder=randomUUID(),newOrder=randomUUID();
  const oldEntitlement=randomUUID(),newEntitlement=randomUUID();
  try{
    await pool.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',
      [account,String(uid)]);
    await pool.query(
      `INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state,created_at)
       VALUES($1,$3,'smart_dns','telegram_stars',500,'XTR','PAID',clock_timestamp()-interval '10 days'),
             ($2,$3,'smart_dns','telegram_stars',100,'XTR','PAID',clock_timestamp())`,
      [oldOrder,newOrder,account]);
    await pool.query(
      `INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,
         starts_at,expires_at,quota_limit_bytes,dns_query_quota_per_30d)
       VALUES ($1,$3,$4,'smart_dns','ACTIVE',1,
         clock_timestamp()-interval '12 days',clock_timestamp()+interval '70 days',NULL,1000000),
              ($2,$3,$5,'smart_dns','ACTIVE',1,
         clock_timestamp()-interval '1 minute',clock_timestamp()+interval '14 days',NULL,1000000)`,
      [oldEntitlement,newEntitlement,account,oldOrder,newOrder]);
    const status=await telegramPersonalDnsSummary(pool,uid);
    assert.equal(status?.state,'ACTIVE');
    assert.ok(status?.expiresAt);
    assert.ok(status!.expiresAt!.getTime()<Date.now()+20*86400*1000,
      'A new 14-day package must win over older 90-day package');
    const issued=await issueTelegramPersonalDns(pool,uid);
    assert.equal(issued.kind,'issued');
    const rows=await pool.query(
      'SELECT entitlement_id FROM personal_dns_credentials WHERE entitlement_id=$1',
      [newEntitlement]);
    assert.equal(rows.rowCount,1);
  }finally{await pool.end();}
});
