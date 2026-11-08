import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {PgOutboxDispatcher,type AdapterMap} from '../../packages/provisioning/src/pg-worker.ts';
import type {ObservedAccess,DesiredAccess} from '../../packages/provisioning/src/reconciler.ts';
import {
  PgVpnTrialReadyQueue,processVpnTrialReadyNotices,trialReadyMessage,
  TelegramTrialReadySender,type VpnTrialReadyNotice,
} from '../../packages/notifications/src/vpn-trial-ready.ts';

const pool=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',
  max:4,connectionTimeoutMillis:1500,
});
after(async()=>pool.end());

test('24h Telegram trial is delivered automatically only after the final node revision, once',async()=>{
  const actor=Number('921'+randomUUID().replace(/-/g,'').slice(0,7)
    .replace(/[a-f]/g,'3')); // valid positive Telegram-like test actor
  await pool.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
  const db=new PgBillingStore(pool);
  const grant=await db.grantTrial(actor,'vpn');
  assert.equal(grant.status,'GRANTED');
  const orderId=grant.orderId!;
  const entitlement=(await pool.query(
    "SELECT id FROM entitlements WHERE source_order_id=$1 AND product='vpn'",[orderId])).rows[0].id;
  const queue=new PgVpnTrialReadyQueue(pool);
  const sent:VpnTrialReadyNotice[]=[];
  const sender={send:async(job:VpnTrialReadyNotice)=>{
    sent.push(job);return {status:'sent' as const};
  }};
  assert.equal((await processVpnTrialReadyNotices(queue,sender)).sent,0);
  const observed=new Map<string,ObservedAccess>();
  const adapter:AdapterMap={vpn:{
    enforcesHardExpiry:true,
    inspect:async(id)=>observed.get(id)??{revision:0,enabled:false},
    apply:async(d:DesiredAccess)=>{
      observed.set(d.entitlementId,{revision:d.revision,enabled:d.enabled,
        expiresAt:d.expiresAt});
      return 'applied';
    },
  }};
  // Do not let unrelated integration fixtures occupy this worker's outbox.
  await pool.query("UPDATE reconcile_outbox SET handled_at=clock_timestamp() WHERE entitlement_id<>$1 AND handled_at IS NULL",[entitlement]);
  const worker=new PgOutboxDispatcher(pool,adapter);
  assert.equal((await worker.processOnce()).status,'synced');
  assert.equal(Number((await pool.query("SELECT revision,state FROM entitlements WHERE id=$1",[entitlement])).rows[0].revision),2);
  assert.equal((await processVpnTrialReadyNotices(queue,sender)).sent,0,
    'a provisional 5-minute credential is NOT proof that full 24 hours are on-node');
  assert.equal((await worker.processOnce()).status,'synced');
  assert.equal((await processVpnTrialReadyNotices(queue,sender)).sent,1);
  assert.equal(sent.length,1);
  assert.equal(sent[0].orderId,orderId);
  assert.equal(sent[0].telegramUserId,String(actor));
  const message=trialReadyMessage(sent[0]);
  assert.match(message.text,/бесплатный VPN готов/);
  assert.ok(message.reply_markup.inline_keyboard.some(row=>
    row.some(button=>button.callback_data==='nav:device:android')));
  assert.ok(message.reply_markup.inline_keyboard.some(row=>
    row.some(button=>button.callback_data==='nav:device:ios')));
  assert.equal((await processVpnTrialReadyNotices(queue,sender)).sent,0,
    'repeated node polls must not send duplicate trial-ready messages');
  const states=(await pool.query('SELECT status,attempts FROM vpn_trial_ready_notifications WHERE order_id=$1',
    [orderId])).rows;
  assert.deepEqual(states,[{status:'SENT',attempts:1}]);
});

test('trial notifier rejects expired trial and disassociated Telegram owner',async()=>{
  const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
  const user='937125770';
  await pool.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',[account,user]);
  await pool.query("INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')",[order,account]);
  await pool.query("INSERT INTO trial_grants(telegram_user_id,account_id,order_id,product,activated_at,access_expires_at) VALUES($1,$2,$3,'vpn',now()-interval '25 hours',now()-interval '1 hour')",[user,account,order]);
  await pool.query("INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,starts_at,expires_at) VALUES($1,$2,$3,'vpn','EXPIRED',2,now()-interval '25 hours',now()-interval '1 hour')",[entitlement,account,order]);
  const queue=new PgVpnTrialReadyQueue(pool);
  const seen:VpnTrialReadyNotice[]=[];
  const result=await processVpnTrialReadyNotices(queue,{send:async(job)=>{seen.push(job);return {status:'sent'};}});
  assert.equal(result.sent,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM vpn_trial_ready_notifications WHERE order_id=$1',[order])).rows[0].n,0);
  assert.equal(seen.length,0);
});

test('Telegram trial-ready sender sends the onboarding device buttons, no bearer URL',async()=>{
  const sent:{body?:Record<string,unknown>}={};
  const fake=async (_url:string,init?:RequestInit)=>{
    sent.body=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ok:true}),{status:200});
  };
  const sender=new TelegramTrialReadySender('123456:'+ 'a'.repeat(40),fake as typeof fetch);
  const outcome=await sender.send({
    orderId:randomUUID(),telegramUserId:'998234123',
    expiresAt:new Date(Date.now()+86000000),attempt:1,
  });
  assert.equal(outcome.status,'sent');
  assert.equal(sent.body?.chat_id,'998234123');
  assert.ok(JSON.stringify(sent.body?.reply_markup).includes('nav:device:android'));
  assert.ok(!JSON.stringify(sent.body).includes('vless://'));
  assert.ok(!JSON.stringify(sent.body).includes('/sub/'));
});
