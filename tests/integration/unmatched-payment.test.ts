import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {handleTelegramUpdate,handleProdamusDelivery,type TelegramApi} from '../../packages/billing/src/handlers.ts';
import {starsPayload} from '../../packages/billing/src/stars.ts';
import {signProdamus} from '../../packages/billing/src/prodamus.ts';
const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
 user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
 database:process.env.PGDATABASE??'mnebyvpn_test',max:6});
const db=new PgBillingStore(pool),key='k'.repeat(48),uid=82220012,suffix=randomUUID().slice(0,8);
const plan='incident-'+suffix;
after(async()=>pool.end());
const pd={formUrl:'https://merchant.payform.ru/',notificationUrl:'https://store.example/n',
 successUrl:'https://store.example/s',returnUrl:'https://store.example/r',secret:key};
const cfg={starsPayloadSecret:key,prodamus:pd};
const tg:TelegramApi={call:async()=>true};
test('authenticated Stars captured mismatch recorded and acknowledged without 503',async()=>{
 await pool.query("INSERT INTO billing_plans(id,product,title,duration_seconds,stars,enabled) "+
  "VALUES($1,'vpn','Unmatched test',3600,37,true)",[plan]);
 const o=await db.createTelegramOrder(uid,plan,'unmatched-'+suffix);
 const event={update_id:111,message:{chat:{id:uid,type:'private'},
  from:{id:uid},successful_payment:{
  currency:'XTR',total_amount:99,invoice_payload:starsPayload(o.id,key),
  telegram_payment_charge_id:'unmatched-tg-'+suffix}}};
 await handleTelegramUpdate(event,db,tg,cfg);
 await handleTelegramUpdate({...event,update_id:112},db,tg,cfg);
 const rows=await pool.query(
  "SELECT reason,sightings FROM payment_incidents WHERE provider='telegram_stars' AND actor_telegram_user_id=$1",
  [uid]);
 assert.equal(rows.rows.length,1);
 assert.equal(rows.rows[0].reason,'STARS_CAPTURE_MISMATCH');
 assert.equal(rows.rows[0].sightings,2);
 assert.equal((await pool.query('SELECT state FROM orders WHERE id=$1',[o.id])).rows[0].state,'PENDING');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_captures WHERE order_id=$1',[o.id]))
  .rows[0].n,0);
 const alerts=await db.pendingPaymentIncidentAlerts();
 assert.ok(alerts.some(x=>x.reason==='STARS_CAPTURE_MISMATCH'));
});
test('signed mismatched Prodamus capture logged, invalid signature is never treated as paid',async()=>{
 const account=randomUUID();
 await pool.query('INSERT INTO accounts(id) VALUES($1)',[account]);
 const id=plan+'-rub';
 await pool.query("INSERT INTO billing_plans(id,product,title,duration_seconds,rub_minor,enabled) "+
  "VALUES($1,'vpn','RUB incident',3600,15900,true)",[id]);
 const order=await db.createWebsiteOrder(account,id,'incident-rub-'+suffix);
 const body={order_num:order.id,order_id:'incident-prodamus-'+suffix,
   domain:'merchant.payform.ru',sum:'1.00',payment_status:'success'};
 const signature=signProdamus(body,key);
 const mismatch=await handleProdamusDelivery(body,signature,db,pd);
 assert.equal(mismatch.statusCode,200);
 assert.equal(mismatch.text,'MANUAL_REVIEW');
 assert.equal((await handleProdamusDelivery(body,'deadbeef',db,pd)).statusCode,401);
 const result=await pool.query(
  "SELECT reason,sightings FROM payment_incidents WHERE provider='prodamus' AND reason='PRODAMUS_CAPTURE_MISMATCH'");
 assert.ok(result.rows.some(x=>x.sightings===1));
});
