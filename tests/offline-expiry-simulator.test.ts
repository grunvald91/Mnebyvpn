import test from 'node:test';
import assert from 'node:assert/strict';
import {OfflineExpiryNodeSimulator} from '../packages/provisioning/src/offline-expiry-simulator.ts';
import {reconcileEntitlement,type DesiredAccess,type ReconcileStore} from '../packages/provisioning/src/reconciler.ts';

test('offline data-plane simulator stops NEW and ESTABLISHED traffic on hard expiry',async()=>{
 let time=new Date('2026-11-06T00:00:00.000Z');
 const adapter=new OfflineExpiryNodeSimulator(()=>time);
 let desired:DesiredAccess={
  entitlementId:'e1',revision:1,enabled:true,
  expiresAt:new Date(time.getTime()+60_000),
 };
 const store:ReconcileStore={
  withLock:async(_id,fn)=>fn(1),
  readDesired:async()=>({...desired}),
  acknowledge:async()=>true,
  requestReconcile:async()=>{},
 };
 assert.deepEqual(await reconcileEntitlement('e1',store,adapter,()=>time),
  {status:'synced',revision:1});
 const session=adapter.connect('e1');
 assert.ok(session);
 assert.equal(adapter.transfer(session!),true);
 adapter.setControlLink(false);
 time=new Date(time.getTime()+60_001);
 assert.equal(adapter.connect('e1'),null);
 assert.equal(adapter.transfer(session!),false);
 adapter.setControlLink(true);
 desired={...desired,enabled:false,revision:2};
 assert.deepEqual(await reconcileEntitlement('e1',store,adapter,()=>time),
  {status:'synced',revision:2});
 assert.equal(adapter.connect('e1'),null);
});
test('control-plane partition does NOT guarantee immediate refund revocation',async()=>{
 let time=new Date('2026-11-06T00:00:00Z');
 const adapter=new OfflineExpiryNodeSimulator(()=>time);
 const pending:DesiredAccess={entitlementId:'e2',revision:1,enabled:true,
  expiresAt:new Date(time.getTime()+600000)};
 await adapter.apply(pending,'initial');
 const session=adapter.connect('e2');
 assert.ok(session);
 adapter.setControlLink(false);
 assert.equal(adapter.transfer(session!),true,
  'only hard expiry or an actual node-side disable stops partitioned traffic');
 await assert.rejects(()=>adapter.apply({...pending,enabled:false,revision:2},'revoke'));
 time=new Date(time.getTime()+600001);
 assert.equal(adapter.transfer(session!),false);
 adapter.setControlLink(true);
 await assert.rejects(()=>adapter.apply({...pending,revision:0,
  expiresAt:new Date(time.getTime()+600000)},'stale'),
  /Stale revision/);
});
test('simulator fails closed if adapter attempts unbounded enabled credential',async()=>{
 const node=new OfflineExpiryNodeSimulator();
 await assert.rejects(()=>node.apply({
  entitlementId:'e3',revision:1,enabled:true,expiresAt:null,
 },'bad'),/Hard expiry/);
 assert.equal(node.connect('e3'),null);
});
