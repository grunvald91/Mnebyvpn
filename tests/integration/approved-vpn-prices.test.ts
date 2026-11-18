import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore,starsOrderFromDB,pricedPlanForOrder} from '../../packages/billing/src/store.ts';
import {buildStarsInvoice,parseStarsPayload} from '../../packages/billing/src/stars.ts';

test('owner approved 15/30/60/90 day 3-in-1 RUB catalog and Telegram Stars plans match migration 0132',async()=>{
 const pool=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
 });
 try{
  const vpn=await pool.query(`SELECT id,duration_seconds,rub_minor,stars,enabled,device_limit
    FROM billing_plans WHERE id=ANY($1::text[]) ORDER BY duration_seconds`,
    [['vpn_15d_1device','vpn_30d_1device','vpn_60d_1device','vpn_90d_1device']]);
  assert.equal(vpn.rowCount,4);
  assert.deepEqual(vpn.rows.map(p=>Number(p.duration_seconds)/86400),[15,30,60,90]);
  assert.deepEqual(vpn.rows.map(p=>Number(p.rub_minor)),[8900,14900,26900,36900]);
  assert.ok(vpn.rows.every(p=>p.enabled===true&&p.device_limit===1));
  assert.deepEqual(vpn.rows.map(p=>Number(p.stars)),[40,60,110,140]);

  const dns=await pool.query(`SELECT id,duration_seconds,rub_minor,stars,enabled,dns_quota_queries_per_30d
    FROM billing_plans WHERE id=ANY($1::text[]) ORDER BY duration_seconds`,
    [['smart_dns_15d_rub','smart_dns_30d_rub','smart_dns_60d_rub','smart_dns_90d_rub']]);
  assert.equal(dns.rowCount,4);
  assert.deepEqual(dns.rows.map(p=>Number(p.rub_minor)),[14900,24900,44900,59900]);
  assert.ok(dns.rows.every(p=>p.enabled===true&&Number(p.dns_quota_queries_per_30d)===1000000&&p.stars===null));

  const bundle=await pool.query(`SELECT id,duration_seconds,rub_minor,stars,enabled,device_limit,dns_quota_queries_per_30d
    FROM billing_plans WHERE id=ANY($1::text[]) ORDER BY duration_seconds`,
    [['bundle_15d_3device','bundle_30d_3device','bundle_60d_3device','bundle_90d_3device']]);
  assert.equal(bundle.rowCount,4);
  assert.deepEqual(bundle.rows.map(p=>Number(p.rub_minor)),[24900,39900,69900,94900]);
  assert.ok(bundle.rows.every(p=>p.enabled===true&&p.device_limit===3&&Number(p.dns_quota_queries_per_30d)===1000000&&p.stars===null));

  const listed=await new PgBillingStore(pool).plans('telegram_stars');
  assert.deepEqual(listed.filter(p=>p.planId.endsWith('_1device')).sort((a,b)=>a.durationSeconds-b.durationSeconds).map(p=>p.stars),[40,60,110,140]);
  const accountId=randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[accountId]);
  const store=new PgBillingStore(pool);
  const order=await store.createWebsiteOrder(accountId,'bundle_30d_3device','test-owner-price-'+randomUUID(),undefined,undefined,'yookassa');
  assert.equal(order.provider,'yookassa');
  assert.equal(order.currency,'RUB');
  assert.equal(order.amount,39900);
  assert.equal(order.durationSeconds,30*86400);
  const terms=await pool.query(`SELECT duration_seconds,device_limit,plan_title,dns_quota_queries_per_30d
     FROM order_terms WHERE order_id=$1`,[order.id]);
  assert.equal(terms.rows[0].device_limit,3);
  assert.equal(Number(terms.rows[0].duration_seconds),30*86400);
  assert.equal(Number(terms.rows[0].dns_quota_queries_per_30d),1000000);
  assert.match(terms.rows[0].plan_title,/3 в 1/);

  const telegramId=100000000+parseInt(randomUUID().replaceAll('-','').slice(0,6),16);
  const starsOrder=await store.createTelegramOrder(telegramId,'vpn_30d_1device',
    'test-owner-stars-'+randomUUID());
  assert.equal(starsOrder.provider,'telegram_stars');
  assert.equal(starsOrder.currency,'XTR');
  assert.equal(starsOrder.amount,60);
  assert.equal(starsOrder.durationSeconds,30*86400);
  const starsInvoice=buildStarsInvoice(starsOrderFromDB(starsOrder),
    pricedPlanForOrder(starsOrder),'a'.repeat(48));
  assert.equal(starsInvoice.currency,'XTR');
  assert.equal(starsInvoice.prices[0].amount,60);
  assert.equal(parseStarsPayload(starsInvoice.payload,'a'.repeat(48)),starsOrder.id);
 }finally{await pool.end();}
});
