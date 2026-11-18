import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileEntitlement} from '../packages/provisioning/src/reconciler.ts';
import {SmartDnsProvisioningAdapter} from '../packages/provisioning/src/smart-dns-adapter.ts';

test('SmartDnsProvisioningAdapter activates PAID_PENDING_PROVISIONING smart_dns entitlement via reconciler',async()=>{
  const id='33333333-3333-4333-8333-333333333333';
  const expiresAt=new Date(Date.now()+30*86400_000);
  let state='PAID_PENDING_PROVISIONING';
  let ackCalled=false;
  const db={
    async query(){
      return {rows:[{product:'smart_dns',state,revision:1,expires_at:expiresAt}]};
    },
  };
  let healthOk=true;
  const adapter=new SmartDnsProvisioningAdapter(db as never,async()=>healthOk);
  const store={
    async withLock<T>(_id:string,fn:(fence:number)=>Promise<T>){return fn(7);},
    async readDesired(){
      return {entitlementId:id,revision:1,enabled:true,expiresAt};
    },
    async acknowledge(_id:string,rev:number,fence:number,obs:boolean){
      assert.equal(rev,1);assert.equal(fence,7);assert.equal(obs,true);
      state='ACTIVE';ackCalled=true;
      return true;
    },
    async requestReconcile(){throw Error('unexpected requestReconcile');},
  };
  const res=await reconcileEntitlement(id,store,adapter);
  assert.equal(res.status,'synced');
  assert.equal(ackCalled,true);
  assert.equal(state,'ACTIVE');

  // When Personal DoT health check fails, adapter refuses activation (fail-closed)
  state='PAID_PENDING_PROVISIONING';
  healthOk=false;
  let requested='';
  const failingAdapter=new SmartDnsProvisioningAdapter(db as never,async()=>false);
  const resFail=await reconcileEntitlement(id,{
    ...store,
    async requestReconcile(_id,reason){requested=reason;},
  },failingAdapter);
  assert.deepEqual(resFail,{status:'retry_required',reason:'unknown_outcome'});
  assert.equal(requested,'unknown_outcome');
  assert.equal(state,'PAID_PENDING_PROVISIONING');
});
