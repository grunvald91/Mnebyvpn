import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {PgBillingStore} from '../../packages/billing/src/store.ts';
import {PgOutboxDispatcher} from '../../packages/provisioning/src/pg-worker.ts';
import {RemnawaveApi} from '../../packages/provisioning/src/remnawave-api.ts';
import {RemnawaveProvisioningAdapter} from '../../packages/provisioning/src/remnawave-adapter.ts';

/** Disposable PostgreSQL + mocked Remnawave HTTP, NOT a node-side E2E proof. */
test('Telegram free trial → Remnawave API → 24h DB grant → profile → revoke',async()=>{
 const pool=new Pool({host:process.env.PGHOST??'localhost',
  port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',
  password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:4});
 const store=new PgBillingStore(pool);
 const actor=945011011;
 let orderId:string|undefined,entitlementId:string|undefined;
 const apiCalls:string[]=[];
 const records=new Map<string,any>();
 const fetcher:typeof fetch=async(input,options)=>{
  const url=new URL(String(input));
  assert.equal(url.origin,'https://panel.example.test');
  assert.ok(url.pathname.startsWith('/api/users'));
  assert.equal((options?.headers as Record<string,string>).Authorization,
    'Bearer synthetic-panel-api-token-value');
  const method=options?.method||'GET';
  apiCalls.push(method);
  if(method==='GET'){
    const username=decodeURIComponent(url.pathname.split('/').at(-1)!);
    const record=records.get(username);
    return record?Response.json({response:record}):
      new Response('',{status:404});
  }
  const inputBody=JSON.parse(String(options?.body));
  const before=records.get(inputBody.username);
  const updated={
    username:inputBody.username,
    status:inputBody.status,
    expireAt:inputBody.expireAt??before?.expireAt,
    description:inputBody.description,
    subscriptionUrl:'https://subs.example.test/subscription/secret',
    id:17,
  };
  records.set(inputBody.username,updated);
  return Response.json({response:updated},{status:method==='POST'?201:200});
 };
 const api=new RemnawaveApi({
  panelUrl:'https://panel.example.test/',
  apiToken:'synthetic-panel-api-token-value',
  subscriptionOrigin:'https://subs.example.test/',
  squadUuids:['123e4567-e89b-42d3-a456-426614174000'],
 },fetcher);
 const adapter=new RemnawaveProvisioningAdapter(api,{
   reportSha256:'b'.repeat(64),
   panelVersion:'3.4.7',nodeVersion:'synthetic',xrayVersion:'synthetic',
 });
 // Panel alone must fail closed: these synthetic tests explicitly inject
 // a fake *node* expiry capability to exercise billing without claiming an
 // actual physical VPN node was tested.
 const blocked=new PgOutboxDispatcher(pool,{vpn:adapter});
 const simulatedNode={
   enforcesHardExpiry:true as const,
   inspect:(id:string)=>adapter.inspect(id),
   apply:(desired:Parameters<typeof adapter.apply>[0],
          operationId:string)=>adapter.apply(desired,operationId),
 };
 const worker=new PgOutboxDispatcher(pool,{vpn:simulatedNode});
 try{
  await pool.query("UPDATE reconcile_outbox SET handled_at=clock_timestamp() WHERE handled_at IS NULL");
  await pool.query("UPDATE trial_offers SET enabled=true WHERE product='vpn'");
  const grant=await store.grantTrial(actor,'vpn');
  assert.equal(grant.status,'GRANTED');
  orderId=grant.orderId!;
  const {rows}=await pool.query(
    'SELECT id,state,revision,expires_at FROM entitlements WHERE source_order_id=$1',
    [orderId]);
  entitlementId=rows[0].id;
  assert.equal(rows[0].expires_at,null);
  const unsafe=await blocked.processOnce(['vpn']);
  assert.equal(unsafe.status,'retry');
  assert.equal(unsafe.reason,'expiry_enforcement_unverified');
  assert.equal(apiCalls.length,0,'Panel alone must not issue trial credentials');
  await pool.query(
    'UPDATE reconcile_outbox SET next_attempt_at=clock_timestamp() WHERE entitlement_id=$1',
    [entitlementId]);
  assert.equal((await worker.processOnce(['vpn'])).status,'synced');
  const first=await pool.query(
    'SELECT state,revision,expires_at FROM entitlements WHERE id=$1',[entitlementId]);
  assert.equal(first.rows[0].state,'ACTIVE');
  assert.equal(Number(first.rows[0].revision),2);
  assert.ok(first.rows[0].expires_at instanceof Date);
  assert.equal((await worker.processOnce(['vpn'])).status,'synced');
  const confirmed=await store.confirmedVpnProfile(actor);
  assert.equal(confirmed?.entitlementId,entitlementId);
  assert.equal(confirmed?.revision,2);
  assert.equal(await api.subscriptionFor(entitlementId!,confirmed!.expiresAt,2),
    'https://subs.example.test/subscription/secret');
  assert.ok(apiCalls.includes('POST')&&apiCalls.includes('PATCH'));

  // On-wire expiry/partition requires separate physical Node tests.
  await pool.query(
    "UPDATE entitlements SET starts_at=now()-interval '26 hours',"+
    " expires_at=now()-interval '2 hours' WHERE id=$1",[entitlementId]);
  assert.equal(await worker.expireDue(),1);
  assert.equal((await worker.processOnce(['vpn'])).status,'synced');
  assert.equal((await api.getByEntitlement(entitlementId!))?.status,'DISABLED');
  assert.equal(await store.confirmedVpnProfile(actor),null);
  assert.equal(await api.subscriptionFor(entitlementId!,confirmed!.expiresAt,2),null);
 }finally{
  if(orderId){
    await pool.query('DELETE FROM trial_grants WHERE order_id=$1',[orderId]).catch(()=>{});
    await pool.query('DELETE FROM reconcile_outbox WHERE entitlement_id=$1',[entitlementId]).catch(()=>{});
    await pool.query('DELETE FROM provisioning_state WHERE entitlement_id=$1',[entitlementId]).catch(()=>{});
    await pool.query('DELETE FROM entitlements WHERE source_order_id=$1',[orderId]).catch(()=>{});
    await pool.query('DELETE FROM orders WHERE id=$1',[orderId]).catch(()=>{});
    await pool.query('DELETE FROM accounts WHERE telegram_user_id=$1',[String(actor)]).catch(()=>{});
  }
  await pool.end();
 }
});
