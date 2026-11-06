import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {PgOutboxDispatcher} from '../../packages/provisioning/src/pg-worker.ts';
import {SignedXrayNodeApi} from '../../packages/provisioning/src/xray-node.ts';

test('signed Xray adapter drives real 24h trial database transitions and revocation',async()=>{
 const pool=new Pool({host:process.env.PGHOST??'localhost',
   port:Number(process.env.PGPORT??5432),
   user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
   database:process.env.PGDATABASE??'mnebyvpn_test',max:4});
 const store=new PgBillingStore(pool);
 const uid=945019049;
 let id:string|undefined,order:string|undefined;
 const state=new Map<string,any>();
 const credential='00000000-0000-4000-8000-000000000123';
 const fakeNode:typeof fetch=async(_url,options)=>{
   const body=JSON.parse(String(options?.body));
   if(body.op==='inspect'){
     const found=state.get(body.id);
     return Response.json(found??{revision:0,enabled:false,expiresAt:null},{headers:{Date:new Date().toUTCString()}});
   }
   const old=state.get(body.id);
   if(old&&old.revision>body.revision)return Response.json({
     status:'stale',revision:old.revision},{headers:{Date:new Date().toUTCString()}});
   state.set(body.id,{revision:body.revision,enabled:body.enabled,
      expiresAt:body.enabled?body.expiresAt:null,
      credential:body.enabled?credential:null});
   return Response.json({status:'applied',revision:body.revision},{headers:{Date:new Date().toUTCString()}});
 };
 const node=new SignedXrayNodeApi('ab'.repeat(32),fakeNode);
 const worker=new PgOutboxDispatcher(pool,{vpn:node});
 try{
   await pool.query("UPDATE reconcile_outbox SET handled_at=clock_timestamp() WHERE handled_at IS NULL");
   await pool.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
   const result=await store.grantTrial(uid,'vpn');
   assert.equal(result.status,'GRANTED');
   order=result.orderId!;
   const q=await pool.query('SELECT id,starts_at,expires_at FROM entitlements WHERE source_order_id=$1',[order]);
   id=q.rows[0].id;
   assert.equal(q.rows[0].expires_at,null);
   assert.equal((await worker.processOnce(['vpn'])).status,'synced');
   const initial=state.get(id!);
   assert.equal(initial.revision,1);
   assert.equal(initial.enabled,true);
   assert.ok(new Date(initial.expiresAt).getTime()>Date.now());
   assert.ok(new Date(initial.expiresAt).getTime()<Date.now()+5*60000+1000);
   assert.equal((await worker.processOnce(['vpn'])).status,'synced');
   const active=await store.confirmedVpnProfile(uid);
   assert.equal(active?.entitlementId,id);
   assert.equal(active?.revision,2);
   assert.equal(state.get(id!).revision,2);
   assert.equal(await node.profileFor(id!,active!.revision,active!.expiresAt),
     'vless://'+credential+'@cdn.servgo.ru:8443?encryption=none&security=tls&type=ws&host=cdn.servgo.ru&sni=cdn.servgo.ru&path=%2Fmnebyvpn-vpn%2Fws#'+encodeURIComponent('Мне бы VPN'));
   // Prove refund/expiry takes away the profile, not just changes the DB state.
   await pool.query(
     "UPDATE entitlements SET starts_at=now()-interval '25 hours',"+
     " expires_at=now()-interval '1 hour' WHERE id=$1",[id]);
   assert.equal(await worker.expireDue(),1);
   assert.equal((await worker.processOnce(['vpn'])).status,'synced');
   assert.equal(state.get(id!).enabled,false);
   assert.equal(await store.confirmedVpnProfile(uid),null);
 }finally{
   if(order){
     await pool.query('DELETE FROM trial_grants WHERE order_id=$1',[order]).catch(()=>{});
     await pool.query('DELETE FROM reconcile_outbox WHERE entitlement_id=$1',[id]).catch(()=>{});
     await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[id]).catch(()=>{});
     await pool.query('DELETE FROM entitlements WHERE source_order_id=$1',[order]).catch(()=>{});
     await pool.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
     await pool.query('DELETE FROM accounts WHERE telegram_user_id=$1',[String(uid)]).catch(()=>{});
   }
   await pool.end();
 }
});
