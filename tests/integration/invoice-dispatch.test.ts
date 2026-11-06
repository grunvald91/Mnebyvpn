import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
 user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
 database:process.env.PGDATABASE??'mnebyvpn_test',max:10});
const db=new PgBillingStore(pool);
const id='invoice-'+randomUUID().slice(0,8);
before(async()=>{
 await pool.query(
  'INSERT INTO billing_plans(id,product,title,duration_seconds,stars,enabled) VALUES($1,$2,$3,$4,$5,true)',
  [id,'vpn','Only one Telegram invoice',15*86400,33]);
});
after(async()=>pool.end());
test('atomic invoice reservation survives 16 parallel duplicate callbacks',async()=>{
 const user=93660001;
 const order=await db.createTelegramOrder(user,id,'same-invoice');
 const results=await Promise.all(Array.from({length:16},()=>db.reserveStarsInvoice(order.id,user)));
 assert.equal(results.filter(Boolean).length,1);
 assert.equal(results.filter(x=>!x).length,15);
 await db.finishStarsInvoice(order.id,'SENT');
 assert.equal(await db.reserveStarsInvoice(order.id,user),false);
 const {rows}=await pool.query('SELECT state,telegram_user_id FROM telegram_invoice_dispatch WHERE order_id=$1',
  [order.id]);
 assert.equal(rows.length,1);
 assert.equal(rows[0].state,'SENT');
 assert.equal(Number(rows[0].telegram_user_id),user);
 await assert.rejects(()=>db.finishStarsInvoice(order.id,'UNKNOWN'),/already resolved/);
});
test('uncertain Telegram HTTP result stays UNKNOWN and cannot be resent',async()=>{
 const user=93660002;
 const order=await db.createTelegramOrder(user,id,'unknown-invoice');
 assert.equal(await db.reserveStarsInvoice(order.id,user),true);
 await db.finishStarsInvoice(order.id,'UNKNOWN');
 assert.equal(await db.reserveStarsInvoice(order.id,user),false);
 assert.equal(await db.reserveStarsInvoice(order.id,user+1),false);
 const {rows}=await pool.query('SELECT state FROM telegram_invoice_dispatch WHERE order_id=$1',[order.id]);
 assert.equal(rows[0].state,'UNKNOWN');
});
test('cannot reserve invoices for cancelled orders or a different Telegram user',async()=>{
 const user=93660003;
 const o=await db.createTelegramOrder(user,id,'wrong-invoice');
 assert.equal(await db.reserveStarsInvoice(o.id,user+1),false);
 await pool.query("UPDATE orders SET state='CANCELLED' WHERE id=$1",[o.id]);
 assert.equal(await db.reserveStarsInvoice(o.id,user),false);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_invoice_dispatch WHERE order_id=$1',[o.id]))
  .rows[0].n,0);
});
