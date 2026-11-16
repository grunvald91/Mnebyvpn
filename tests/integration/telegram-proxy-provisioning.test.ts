import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {reconcileProxyEntitlement,type TelemtAdministrator}
  from '../../packages/web/src/telegram-proxy-provisioning.ts';

test('MTProxy bonus is created once for PAID DNS only and disabled after refund',async()=>{
  const pool=new Pool({
    host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
    user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
    database:process.env.PGDATABASE??'mnebyvpn_test',max:1,
  });
  const client=await pool.connect();
  const id=randomUUID(),order=randomUUID(),owner=randomUUID();
  // Isolate fixture inside a rollback-only transaction on one client.
  // The service advisory lock is session-bound and uses this same client.
  const db={connect:async()=>({
    query:client.query.bind(client),release(){},
  })} as unknown as Pool;
  const key='b'.repeat(64),domain='xapi.ozon.ru';
  let ensured=0,disabled=0,lastUser='',lastSecret='';
  const admin:TelemtAdministrator={
    async get(){return null;},
    async ensure(username,secret,expiresAt){
      ensured++;
      assert.match(username,/^dns_[a-f0-9]{24}$/);
      assert.match(secret,/^[a-f0-9]{32}$/);
      assert.ok(expiresAt.getTime()>Date.now());
      lastUser=username;lastSecret=secret;
      return true;
    },
    async disable(username){
      disabled++;
      assert.equal(username,lastUser);
      return true;
    },
  };
  try{
    await client.query('BEGIN');
    await client.query('INSERT INTO accounts(id) VALUES($1)',[owner]);
    await client.query(`INSERT INTO orders(id,account_id,product,provider,
      amount_minor,currency,state)
      VALUES($1,$2,'smart_dns','fixture',20000,'RUB','PENDING')`,[order,owner]);
    await client.query(`INSERT INTO entitlements(id,account_id,source_order_id,product,
      state,revision,starts_at,expires_at,quota_limit_bytes)
      VALUES($1,$2,$3,'smart_dns','ACTIVE',1,
        clock_timestamp()-interval '1 hour',clock_timestamp()+interval '30 days',10000000)`,
      [id,owner,order]);

    assert.equal(await reconcileProxyEntitlement(db,admin,id,key,domain),'skipped');
    assert.equal(ensured,0);
    assert.equal((await client.query(
      'SELECT count(*)::integer AS n FROM dns_mtproxy_bonus_credentials WHERE entitlement_id=$1',
      [id])).rows[0].n,0);

    await client.query("UPDATE orders SET state='PAID' WHERE id=$1",[order]);
    assert.equal(await reconcileProxyEntitlement(db,admin,id,key,domain),'activated');
    assert.equal(ensured,1);
    const {rows}=await client.query(
      'SELECT state,secret_box,telemt_username,verified_at FROM dns_mtproxy_bonus_credentials WHERE entitlement_id=$1',
      [id]);
    assert.equal(rows[0].state,'ACTIVE');
    assert.ok(rows[0].verified_at);
    assert.equal(rows[0].telemt_username,lastUser);
    assert.ok(!rows[0].secret_box.includes(lastSecret),'plaintext secret leaked in DB');

    await client.query("UPDATE orders SET state='REFUNDED' WHERE id=$1",[order]);
    assert.equal(await reconcileProxyEntitlement(db,admin,id,key,domain),'disabled');
    assert.equal(disabled,1);
    const done=(await client.query(
      'SELECT state,disabled_at,verified_at FROM dns_mtproxy_bonus_credentials WHERE entitlement_id=$1',
      [id])).rows[0];
    assert.equal(done.state,'DISABLED');
    assert.ok(done.disabled_at);
    assert.equal(done.verified_at,null);
    assert.equal(await reconcileProxyEntitlement(db,admin,id,key,domain),'skipped');
  }finally{
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
