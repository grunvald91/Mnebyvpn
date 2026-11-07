import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {Pool} from 'pg';
import {PgVpnNodeRegistry} from '../../packages/nodes/src/pg-registry.ts';
import {PgNodeFanoutStore} from '../../packages/nodes/src/pg-fanout.ts';
import {reconcileAllAssignedNodes} from '../../packages/nodes/src/fanout.ts';
import type {DesiredAccess,ObservedAccess,ProvisioningAdapter}
  from '../../packages/provisioning/src/reconciler.ts';

function pool():Pool {
  return new Pool({
    host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
    user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
    database:process.env.PGDATABASE??'mnebyvpn_test',max:5,
  });
}
async function approved(registry:PgVpnNodeRegistry,db:Pool,id:string,kind:'normal'|'special',cap:number){
  await registry.registerPlanned({
    id,code:'node-'+id.slice(0,8),countryCode:'DE',
    kind,capabilities:['vless-ws-tls'],maxClients:cap,
  });
  await db.query("UPDATE vpn_nodes SET state='testing' WHERE id=$1",[id]);
  await db.query("UPDATE vpn_nodes SET state='canary' WHERE id=$1",[id]);
  await db.query(
    "UPDATE vpn_nodes SET state='verified',verified_at=clock_timestamp(),"+
    "verification_report_sha256=repeat('b',64),operator_approved_at=clock_timestamp(),"+
    "enabled_for_new=true WHERE id=$1",[id]);
  await registry.recordProbe(id,true);
}
test('paid renewal cannot exceed capacity when it reopens a revoked assignment',async()=>{
  const db=pool(),registry=new PgVpnNodeRegistry(db);
  const account=randomUUID(),orderA=randomUUID(),orderB=randomUUID();
  const a=randomUUID(),b=randomUUID(),node=randomUUID();
  try{
    await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
    for(const id of [orderA,orderB])
      await db.query("INSERT INTO orders(id,account_id,product,amount_minor,currency,state) "+
        "VALUES($1,$2,'vpn',0,'RUB','PAID')",[id,account]);
    for(const [id,order] of [[a,orderA],[b,orderB]])
      await db.query(
        "INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,expires_at) "+
        "VALUES($1,$2,$3,'vpn','ACTIVE',1,now()+interval '1 hour')",
        [id,account,order]);
    await approved(registry,db,node,'normal',1);
    assert.equal(await registry.reserve(a,node,{capability:'vless-ws-tls'}),'reserved');
    await db.query("UPDATE entitlements SET state='REFUNDED',revision=2 WHERE id=$1",[a]);
    await db.query(
      "UPDATE vpn_node_assignments SET state='revoked',applied_revision=2,"+
      "applied_node_revision=desired_node_revision WHERE node_id=$1 AND entitlement_id=$2",
      [node,a]);
    // Race renewal against a competing reservation: both acquire the same
    // node row lock, so precisely one allocation may occupy capacity=1.
    const [renewal,admission]=await Promise.all([
      db.query(
        "UPDATE entitlements SET state='PAID_PENDING_PROVISIONING',revision=3,"+
        "expires_at=expires_at+interval '1 day' WHERE id=$1",[a]),
      registry.reserve(b,node,{capability:'vless-ws-tls'}),
    ]);
    assert.equal(renewal.rowCount,1);
    assert.ok(['reserved','unavailable'].includes(admission));
    const {rows}=await db.query(
      'SELECT entitlement_id,state,last_error_code,desired_node_revision FROM vpn_node_assignments WHERE node_id=$1 ORDER BY entitlement_id',
      [node]);
    if(admission==='reserved'){
      assert.equal(rows.find(x=>x.entitlement_id===a)?.state,'failed');
      assert.equal(rows.find(x=>x.entitlement_id===a)?.last_error_code,'node_capacity');
      assert.equal(rows.find(x=>x.entitlement_id===b)?.state,'pending');
    }else{
      assert.equal(rows.find(x=>x.entitlement_id===a)?.state,'pending');
      assert.equal(rows.find(x=>x.entitlement_id===b),undefined);
    }
    assert.equal((await db.query(
      "SELECT state FROM entitlements WHERE id=$1",[a])).rows[0].state,
      'PAID_PENDING_PROVISIONING');
    const {rows:occupied}=await db.query(
      "SELECT count(*)::int AS n FROM vpn_node_assignments "+
      "WHERE node_id=$1 AND state IN ('pending','active','revoking')",[node]);
    assert.equal(occupied[0].n,1);
  }finally{
    await db.query('DELETE FROM vpn_node_assignments WHERE node_id=$1',[node]).catch(()=>{});
    await db.query('DELETE FROM entitlements WHERE id IN ($1,$2)',[a,b]).catch(()=>{});
    await db.query('DELETE FROM orders WHERE id IN ($1,$2)',[orderA,orderB]).catch(()=>{});
    await db.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
    await db.query('DELETE FROM vpn_nodes WHERE id=$1',[node]).catch(()=>{});
    await db.end();
  }
});

test('special node requires explicit consent; trial uses provisional hard expiry then 24h',async()=>{
  const db=pool(),registry=new PgVpnNodeRegistry(db),store=new PgNodeFanoutStore(db);
  const account=randomUUID(),order=randomUUID(),entitlement=randomUUID(),node=randomUUID();
  const actor=randomInt(2_000_000_000,9_000_000_000);
  let observed:ObservedAccess={revision:0,enabled:false,absent:true};
  const seen:DesiredAccess[]=[];
  try{
    await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
    await db.query("INSERT INTO orders(id,account_id,product,amount_minor,currency,state) "+
      "VALUES($1,$2,'vpn',0,'RUB','TRIAL')",[order,account]);
    await db.query(
      "INSERT INTO trial_grants(telegram_user_id,account_id,order_id,product) "+
      "VALUES($1,$2,$3,'vpn')",[actor,account,order]);
    await db.query(
      "INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,expires_at) "+
      "VALUES($1,$2,$3,'vpn','PAID_PENDING_PROVISIONING',1,NULL)",
      [entitlement,account,order]);
    await approved(registry,db,node,'special',3);
    assert.equal(await registry.reserve(entitlement,node,{
      capability:'vless-ws-tls'}),'unavailable');
    assert.equal(await registry.reserve(entitlement,node,{
      capability:'vless-ws-tls',allowSpecial:true}),'reserved');
    const ad:ProvisioningAdapter={
      enforcesHardExpiry:true,
      inspect:async()=>observed,
      apply:async d=>{
        seen.push({...d});
        observed={revision:d.revision,enabled:d.enabled,expiresAt:d.expiresAt};
        return 'applied';
      },
    };
    const adapters=new Map([[node,ad]]);
    const one=await reconcileAllAssignedNodes(entitlement,store,adapters);
    assert.deepEqual(one.map(x=>x.status),['synced']);
    assert.equal(seen[0].trialPendingActivation,true);
    assert.ok(seen[0].expiresAt!.getTime()-Date.now()<=300000);
    assert.ok(seen[0].expiresAt!.getTime()-Date.now()>280000);
    const {rows:confirmed}=await db.query(
      'SELECT state,allow_special,applied_node_revision FROM vpn_node_assignments WHERE entitlement_id=$1',
      [entitlement]);
    assert.equal(confirmed[0].state,'active');
    assert.equal(confirmed[0].allow_special,true);
    assert.equal(Number(confirmed[0].applied_node_revision),1);
    // Simulate legacy business activation, including the 24-hour deadline.
    const activated=new Date();
    await db.query(
      "UPDATE trial_grants SET activated_at=$2,access_expires_at=$2::timestamptz+interval '24 hours' "+
      "WHERE order_id=$1",[order,activated]);
    await db.query(
      "UPDATE entitlements SET starts_at=$2,expires_at=$2::timestamptz+interval '24 hours',"+
      "revision=2,state='ACTIVE' WHERE id=$1",[entitlement,activated]);
    const two=await reconcileAllAssignedNodes(entitlement,store,adapters);
    assert.deepEqual(two.map(x=>x.status),['synced']);
    assert.equal(seen.at(-1)?.revision,2);
    assert.equal(seen.at(-1)?.trialPendingActivation,false);
    assert.equal(seen.at(-1)?.expiresAt?.getTime(),activated.getTime()+86400000);
  }finally{
    await db.query('DELETE FROM vpn_node_assignments WHERE entitlement_id=$1',[entitlement]).catch(()=>{});
    await db.query('DELETE FROM entitlements WHERE id=$1',[entitlement]).catch(()=>{});
    await db.query('DELETE FROM trial_grants WHERE order_id=$1',[order]).catch(()=>{});
    await db.query('DELETE FROM orders WHERE id=$1',[order]).catch(()=>{});
    await db.query('DELETE FROM accounts WHERE id=$1',[account]).catch(()=>{});
    await db.query('DELETE FROM vpn_nodes WHERE id=$1',[node]).catch(()=>{});
    await db.end();
  }
});
