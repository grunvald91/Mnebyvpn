import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';

test('owner approved 15/30/60/90 day VPN offers are exactly 60/99/199/249 RUB for one device',async()=>{
 const pool=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
 });
 try{
  const plans=await pool.query(`SELECT id,duration_seconds,rub_minor,stars,enabled,device_limit
    FROM billing_plans WHERE id=ANY($1::text[]) ORDER BY duration_seconds`,
    [['vpn_15d_1device','vpn_30d_1device','vpn_60d_1device','vpn_90d_1device']]);
  assert.equal(plans.rowCount,4);
  assert.deepEqual(plans.rows.map(p=>Number(p.duration_seconds)/86400),[15,30,60,90]);
  assert.deepEqual(plans.rows.map(p=>Number(p.rub_minor)),[6000,9900,19900,24900]);
  assert.ok(plans.rows.every(p=>p.enabled===true&&p.device_limit===1));
  // XTR amounts are separate fixed owner prices, based on an 18% buyer cost markup.
  assert.deepEqual(plans.rows.map(p=>Number(p.stars)),[34,56,112,141]);
  const listed=await new PgBillingStore(pool).plans('telegram_stars');
  assert.deepEqual(listed.filter(p=>p.planId.endsWith('_1device')).sort((a,b)=>a.durationSeconds-b.durationSeconds).map(p=>p.stars),[34,56,112,141]);
  const others=await pool.query(`SELECT count(*)::int AS n FROM billing_plans
    WHERE product='vpn' AND enabled=true
      AND duration_seconds IN (15*86400,30*86400,60*86400,90*86400)
      AND id<>ALL($1::text[])`,
    [['vpn_15d_1device','vpn_30d_1device','vpn_60d_1device','vpn_90d_1device']]);
  assert.equal(others.rows[0].n,0);
  const accountId=randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[accountId]);
  const store=new PgBillingStore(pool);
  const order=await store.createWebsiteOrder(accountId,'vpn_30d_1device','test-owner-price-'+randomUUID());
  assert.equal(order.provider,'prodamus');
  assert.equal(order.currency,'RUB');
  assert.equal(order.amount,9900);
  assert.equal(order.durationSeconds,30*86400);
  const terms=await pool.query(`SELECT duration_seconds,device_limit,plan_title
     FROM order_terms WHERE order_id=$1`,[order.id]);
  assert.equal(terms.rows[0].device_limit,1);
  assert.equal(Number(terms.rows[0].duration_seconds),30*86400);
  assert.match(terms.rows[0].plan_title,/1 устройство/);
 }finally{await pool.end();}
});
