import test from 'node:test';
import assert from 'node:assert/strict';
import {runProvisioningCycle,runProvisioningLoop} from '../packages/provisioning/src/runner.ts';
test('runner executes expiry, drift and bounded queue operations',async()=>{
 const seq:string[]=[];
 let n=0;
 const worker={
  expireDue:async()=>{seq.push('expire');return 2;},
  scheduleDriftScan:async()=>{seq.push('drift');return 1;},
  processOnce:async()=>{
   seq.push('process');
   n++;
   return n===1?{status:'synced' as const}:
     n===2?{status:'retry' as const}:{status:'empty' as const};
  },
 };
 assert.deepEqual(await runProvisioningCycle(worker),{
  expired:2,driftScheduled:1,synced:1,retried:1,
 });
 assert.deepEqual(seq,['expire','drift','process','process','process']);
});
test('runner has finite per-cycle limit, never spins forever on failing adapter',async()=>{
 let n=0;
 const w={
  expireDue:async()=>0,scheduleDriftScan:async()=>0,
  processOnce:async()=>{n++;return {status:'retry' as const};},
 };
 const s=await runProvisioningCycle(w,3);
 assert.equal(n,3);
 assert.equal(s.retried,3);
});
test('worker loop supports clean SIGTERM-style AbortSignal',async()=>{
 const ctrl=new AbortController(),reports:any[]=[];
 await runProvisioningLoop({
  expireDue:async()=>0,scheduleDriftScan:async()=>0,
  processOnce:async()=>{ctrl.abort();return {status:'empty' as const};},
 },ctrl.signal,r=>reports.push(r),100);
 assert.equal(reports.length,1);
});
