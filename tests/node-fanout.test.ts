import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileAssignedNode,reconcileAllAssignedNodes}
  from '../packages/nodes/src/fanout.ts';
import type {NodeFanoutStore} from '../packages/nodes/src/fanout.ts';
import type {DesiredAccess,ObservedAccess,ProvisioningAdapter}
  from '../packages/provisioning/src/reconciler.ts';

const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const expiry=new Date(Date.now()+3600000);
function fixture(){
 const desired:DesiredAccess={entitlementId:id,revision:1,enabled:true,expiresAt:expiry};
 const desiredByNode=new Map([[a,{...desired}],[b,{...desired}]]);
 const observed=new Map<string,ObservedAccess>();
 const ack:string[]=[];
 const retries:string[]=[];
 const operations:string[]=[];
 const store:NodeFanoutStore={
  listNodeIds:async()=>[b,a],
  withNodeLock:async(_id,_node,fn)=>fn(1),
  readDesired:async(_id,node)=>({...desiredByNode.get(node)!}),
  acknowledge:async(_id,node,rev,fence,enabled)=>{
   const current=desiredByNode.get(node)!;
   if(fence!==1||rev!==current.revision||enabled!==current.enabled)return false;
   ack.push(node+':'+rev+':'+enabled);return true;
  },
  retry:async(_id,node,reason)=>{retries.push(node+':'+reason);},
 };
 function adapter(nodeId:string):ProvisioningAdapter{
  return {
   enforcesHardExpiry:true,
   inspect:async()=>observed.get(nodeId)??{revision:0,enabled:false,expiresAt:null,absent:true},
   apply:async(d,op)=>{
    operations.push(nodeId+':'+op);
    observed.set(nodeId,{revision:d.revision,enabled:d.enabled,expiresAt:d.expiresAt});
    return 'applied';
   },
  };
 }
 return {store,adapter,desiredByNode,observed,ack,retries,operations};
}
test('two independent nodes activate and are acknowledged separately',async()=>{
 const x=fixture();
 const res=await reconcileAllAssignedNodes(id,x.store,new Map([
  [a,x.adapter(a)],[b,x.adapter(b)],
 ]));
 assert.deepEqual(res.map(v=>v.status),['synced','synced']);
 assert.equal(x.ack.length,2);
 assert.equal(x.operations.length,2);
 assert.ok(x.operations.every(s=>s.endsWith(':1:enable')));
});
test('failed node does not block safe revoke on other node',async()=>{
 const x=fixture();
 for(const n of [a,b]){
  x.desiredByNode.set(n,{entitlementId:id,revision:2,enabled:false,expiresAt:null});
  x.observed.set(n,{revision:1,enabled:true,expiresAt:expiry});
 }
 const bad:ProvisioningAdapter={
  enforcesHardExpiry:true,
  inspect:async()=>{throw Error('upstream unavailable');},
  apply:async()=>{throw Error('should not send');},
 };
 const res=await reconcileAllAssignedNodes(id,x.store,new Map([
  [a,bad],[b,x.adapter(b)],
 ]));
 assert.equal(res.find(v=>v.nodeId===a)?.status,'retry_required');
 assert.equal(res.find(v=>v.nodeId===b)?.status,'synced');
 assert.ok(x.operations.some(s=>s.startsWith(b)&&s.endsWith(':2:disable')));
 assert.deepEqual(x.ack,[b+':2:false']);
 assert.deepEqual(x.retries,[a+':unknown_outcome']);
});
test('late enable is corrected after revision advances before acknowledgement',async()=>{
 const x=fixture();
 const adapter:ProvisioningAdapter={
  enforcesHardExpiry:true,
  inspect:async()=>x.observed.get(a)??{revision:0,enabled:false,absent:true},
  apply:async(d)=>{
   x.observed.set(a,{revision:d.revision,enabled:d.enabled,expiresAt:d.expiresAt});
   if(d.enabled)x.desiredByNode.set(a,{entitlementId:id,revision:2,enabled:false,expiresAt:null});
   return 'applied';
  },
 };
 const result=await reconcileAssignedNode(id,a,x.store,adapter);
 assert.deepEqual(result,{status:'synced',revision:2});
 assert.deepEqual(x.ack,[a+':2:false']);
 assert.equal(x.observed.get(a)?.enabled,false);
});
test('partial node configuration does not pretend success',async()=>{
 const x=fixture();
 const res=await reconcileAllAssignedNodes(id,x.store,new Map([[a,x.adapter(a)]]));
 assert.deepEqual(res.map(v=>v.status),['synced','retry_required']);
 assert.deepEqual(x.retries,[b+':node_unconfigured']);
});
test('node must prove local hard expiry before any enable/revoke acknowledgement',async()=>{
 const x=fixture();
 const unsafe:ProvisioningAdapter={
  inspect:async()=>({revision:1,enabled:true,expiresAt:expiry}),
  apply:async()=> 'applied',
 };
 assert.deepEqual(await reconcileAssignedNode(id,a,x.store,unsafe),{
  status:'retry_required',reason:'expiry_unverified',
 });
 assert.deepEqual(x.ack,[]);
});
test('incorrect observed deadline is not published',async()=>{
 const x=fixture();
 const bad:ProvisioningAdapter={
  enforcesHardExpiry:true,
  inspect:async()=>({revision:1,enabled:true,expiresAt:new Date(expiry.getTime()+60000)}),
  apply:async()=> 'applied',
 };
 assert.deepEqual(await reconcileAssignedNode(id,a,x.store,bad),{
  status:'retry_required',reason:'verification_failed',
 });
 assert.deepEqual(x.ack,[]);
});
