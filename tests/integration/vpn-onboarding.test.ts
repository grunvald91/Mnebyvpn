import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {issueSubscriptionLink,subscriptionOwner,subscriptionLink,installerLink}
  from '../../packages/provisioning/src/subscription-links.ts';
import {activationView,deviceView,manualView}
  from '../../apps/service/src/vpn-onboarding.ts';

test('a confirmed VPN grant issues only hashed subscriber URLs and per-platform bot buttons',async()=>{
 const pool=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
   user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
   database:process.env.PGDATABASE??'mnebyvpn_test'});
 const user=9926100611;
 const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
 const expiry=new Date(Date.now()+24*3600000);
 try{
   await pool.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,$2)',
     [account,String(user)]);
   await pool.query(
     "INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) "+
     "VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')",[order,account]);
   await pool.query(
     "INSERT INTO entitlements(id,account_id,source_order_id,product,state,"+
     "revision,starts_at,expires_at) "+
     "VALUES($1,$2,$3,'vpn','ACTIVE',2,now(),$4)",
     [entitlement,account,order,expiry]);
   await pool.query(
     "INSERT INTO provisioning_state(entitlement_id,adapter,applied_revision,"+
     "fencing_token,last_observed_at) VALUES($1,'vpn',2,2,now())",[entitlement]);
   const activation=await activationView(pool,user);
   assert.match(activation!.text,/VPN активирован/);
   assert.ok(activation!.reply_markup.inline_keyboard.some(row=>
     row.some(b=>b.callback_data==='nav:device:ios')));
   const link=await issueSubscriptionLink(pool,user);
   assert.ok(link);
   assert.match(link!.link,/^https:\/\/cdn\.servgo\.ru:8443\/sub\/[A-Za-z0-9_-]{43}$/);
   assert.equal(subscriptionLink(link!.token),link!.link);
   const hash=createHash('sha256').update(link!.token).digest('hex');
   const record=await pool.query(
     'SELECT token_sha256 FROM vpn_subscription_links WHERE entitlement_id=$1',
     [entitlement]);
   assert.equal(record.rows[0].token_sha256,hash);
   assert.ok(!JSON.stringify(record.rows).includes(link!.token));
   const owner=await subscriptionOwner(pool,link!.token);
   assert.equal(owner?.telegramUserId,user);
   assert.equal(owner?.entitlementId,entitlement);
   assert.equal(await subscriptionOwner(pool,'malformed'),null);
   assert.equal(await subscriptionOwner(pool,'x'.repeat(43)),null);
   assert.match(installerLink(link!.token,'incy'),/client=incy$/);
   const ios=await deviceView(pool,user,'ios');
   assert.match(ios.text,/Karing/);
   assert.ok(ios.reply_markup.inline_keyboard.some(row=>
     row.some(b=>b.url==='https://apps.apple.com/ru/app/karing/id6472431552')));
   assert.ok(ios.reply_markup.inline_keyboard.some(row=>
     row.some(b=>b.url?.includes('client=karing'))));
   const android=await deviceView(pool,user,'android');
   assert.match(android.text,/INCY/);
   assert.ok(android.reply_markup.inline_keyboard.some(row=>
     row.some(b=>b.url?.startsWith('https://play.google.com/store/apps/details'))));
   assert.ok(android.reply_markup.inline_keyboard.some(row=>
     row.some(b=>b.copy_text?.text.startsWith('https://cdn.servgo.ru:8443/sub/'))));
   const manual=await manualView(pool,user);
   assert.ok(manual.reply_markup.inline_keyboard.some(row=>
     row.some(b=>b.copy_text?.text.startsWith('https://cdn.servgo.ru:8443/sub/'))));
   await pool.query("UPDATE entitlements SET state='EXPIRED' WHERE id=$1",[entitlement]);
   assert.equal(await subscriptionOwner(pool,link!.token),null);
   assert.equal(await issueSubscriptionLink(pool,user),null);
   assert.equal((await activationView(pool,user))?.reply_markup.inline_keyboard[0][0].callback_data,
     'nav:connect');
 }finally{
   await pool.query('DELETE FROM vpn_subscription_links WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
   await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
   await pool.query('DELETE FROM entitlements WHERE id=$1',[entitlement]).catch(()=>{});
   await pool.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
   await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
   await pool.end();
 }
});
