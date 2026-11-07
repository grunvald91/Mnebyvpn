import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {PgVpnNodeRegistry} from '../../packages/nodes/src/pg-registry.ts';
import {PgNodeFanoutStore} from '../../packages/nodes/src/pg-fanout.ts';
import {reconcileAllAssignedNodes}
  from '../../packages/nodes/src/fanout.ts';
import {loadMultiNodeSubscription}
  from '../../packages/nodes/src/subscription.ts';
import {makeVpnImportUri}
  from '../../packages/provisioning/src/xray-node.ts';
import type {ProvisioningAdapter,ObservedAccess}
  from '../../packages/provisioning/src/reconciler.ts';

test('node-scoped access, subscription publication and refund revoke end-to-end in test DB',async()=>{
 const pool=new Pool({
  host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
  user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
  database:process.env.PGDATABASE??'mnebyvpn_test',max:7,
 });
 const registry=new PgVpnNodeRegistry(pool);
 const store=new PgNodeFanoutStore(pool);
 const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
 const nodeIds=[randomUUID(),randomUUID()];
 const codes=['de-test-'+nodeIds[0].slice(0,8),
              'nl-test-'+nodeIds[1].slice(0,8)];
 const token=randomBytes(32).toString('base64url');
 const digest=createHash('sha256').update(token).digest('hex');
 const state=new Map<string,ObservedAccess>();
 const creds=[
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
 ];
 const profiles=new Map<string,{profileFor:(_id:string,_rev:number,_expire:Date)=>Promise<string|null>}>();
 const adapters=new Map<string,ProvisioningAdapter>();
 try{
  await pool.query('INSERT INTO accounts(id) VALUES($1)',[account]);
  await pool.query(
    "INSERT INTO orders(id,account_id,product,amount_minor,currency,state) "+
    "VALUES($1,$2,'vpn',0,'RUB','PAID')",[order,account]);
  await pool.query(
    "INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,expires_at) "+
    "VALUES($1,$2,$3,'vpn','ACTIVE',1,clock_timestamp()+interval '1 hour')",
    [entitlement,account,order]);
  await pool.query(
    'INSERT INTO vpn_subscription_links(token_sha256,entitlement_id) VALUES($1,$2)',
    [digest,entitlement]);
  for(let i=0;i<2;i++){
   const nodeId=nodeIds[i];
   const host='vpn-'+i+'.example.test';
   await registry.registerPlanned({
    id:nodeId,code:codes[i],countryCode:i===0?'DE':'NL',
    kind:'normal',capabilities:['vless-ws-tls'],maxClients:4,
   });
   await registry.recordProbe(nodeId,true);
   await pool.query(
    "UPDATE vpn_nodes SET state='verified',verified_at=clock_timestamp(),"+
    "verification_report_sha256=repeat('b',64),"+
    "operator_approved_at=clock_timestamp(),enabled_for_new=true,"+
    "client_host=$2,client_port=8443,client_sni=$2,client_ws_path='/sub/ws' "+
    "WHERE id=$1",[nodeId,host]);
   assert.equal(await registry.reserve(entitlement,nodeId,{
    capability:'vless-ws-tls'}),'reserved');
   const route={
    controlUrl:'https://control.example.test/v1/provision',
    publicHost:host,publicPort:8443,tlsServerName:host,wsPath:'/sub/ws',
    label:'MNEBYVPN '+codes[i],
   };
   profiles.set(nodeId,{profileFor:async()=>makeVpnImportUri(creds[i],route)});
   adapters.set(nodeId,{
    enforcesHardExpiry:true,
    inspect:async()=>state.get(nodeId)??{revision:0,enabled:false,absent:true},
    apply:async(desired)=>{
      state.set(nodeId,{revision:desired.revision,
       enabled:desired.enabled,expiresAt:desired.expiresAt});
      return 'applied';
    },
   });
  }
  assert.equal(await loadMultiNodeSubscription(pool,token,profiles),null,
    'pending assignments must not be published');
  const sync=await reconcileAllAssignedNodes(entitlement,store,adapters);
  assert.deepEqual(sync.map(x=>x.status),['synced','synced']);
  const rows=await pool.query(
    'SELECT state,applied_revision,last_observed_at FROM vpn_node_assignments '+
    'WHERE entitlement_id=$1',[entitlement]);
  assert.deepEqual(rows.rows.map(x=>x.state),['active','active']);
  assert.ok(rows.rows.every(x=>Number(x.applied_revision)===1 && x.last_observed_at));
  const subscription=await loadMultiNodeSubscription(pool,token,profiles);
  assert.equal(subscription?.profiles.length,2);
  assert.equal(subscription?.text.trim().split('\n').length,2);
  assert.ok(subscription?.text.includes('vpn-0.example.test'));
  assert.ok(subscription?.text.includes('vpn-1.example.test'));
  assert.equal(await loadMultiNodeSubscription(pool,'invalid',profiles),null);

  // When one node goes unhealthy, its profile disappears without revoking
  // the second healthy node's access.
  await registry.recordProbe(nodeIds[0],false);
  const degraded=await loadMultiNodeSubscription(pool,token,profiles);
  assert.equal(degraded?.profiles.length,1);
  assert.ok(degraded?.text.includes('vpn-1.example.test'));

  await pool.query(
    "UPDATE entitlements SET state='REFUNDED',revision=revision+1 "+
    'WHERE id=$1',[entitlement]);
  const queued=await pool.query(
    'SELECT state,desired_revision FROM vpn_node_assignments WHERE entitlement_id=$1',
    [entitlement]);
  assert.deepEqual(queued.rows.map(x=>x.state),['revoking','revoking'],
    'refund must enqueue revoke on every assigned node');
  const revoke=await reconcileAllAssignedNodes(entitlement,store,adapters);
  assert.deepEqual(revoke.map(x=>x.status),['synced','synced']);
  assert.ok([...state.values()].every(x=>x.enabled===false&&x.revision===2));
  const revoked=await pool.query(
    'SELECT state,applied_revision FROM vpn_node_assignments WHERE entitlement_id=$1',
    [entitlement]);
  assert.ok(revoked.rows.every(x=>x.state==='revoked'&&Number(x.applied_revision)===2));
  assert.equal(await loadMultiNodeSubscription(pool,token,profiles),null);
 }finally{
  await pool.query('DELETE FROM vpn_subscription_links WHERE entitlement_id=$1',
    [entitlement]).catch(()=>{});
  await pool.query('DELETE FROM vpn_node_assignments WHERE entitlement_id=$1',
    [entitlement]).catch(()=>{});
  await pool.query('DELETE FROM entitlements WHERE id=$1',[entitlement]).catch(()=>{});
  await pool.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
  await pool.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
  for(const nodeId of nodeIds)
   await pool.query('DELETE FROM vpn_nodes WHERE id=$1',[nodeId]).catch(()=>{});
  await pool.end();
 }
});
