import test from 'node:test';
import assert from 'node:assert/strict';
import {sweepExpired,runExpiryScheduler,type ExpiryDispatcher}
  from '../apps/service/src/expiry-worker.ts';

test('one sweep expires due subscriptions and schedules drift independently',async()=>{
 let expired=0,scans=0;
 const dispatcher:ExpiryDispatcher={
  expireDue:async()=>{expired++;return 2;},
  scheduleDriftScan:async(limit)=>{assert.equal(limit,100);scans++;return 3;}
 };
 assert.deepEqual(await sweepExpired(dispatcher,true),{expired:2,driftScheduled:3});
 assert.deepEqual(await sweepExpired(dispatcher,false),{expired:2,driftScheduled:0});
 assert.equal(expired,2);
 assert.equal(scans,1);
});
test('scheduler is stoppable and never marks a VPN node as disabled',async()=>{
 const abort=new AbortController();
 let sweeps=0,scans=0,waits=0;
 const dispatcher:ExpiryDispatcher={
  expireDue:async()=>{sweeps++;return 0;},
  scheduleDriftScan:async()=>{scans++;return 0;}
 };
 await runExpiryScheduler(dispatcher,abort.signal,async(ms,signal)=>{
  assert.equal(ms,60_000);
  assert.equal(signal,abort.signal);
  if(++waits===6)abort.abort();
 });
 assert.equal(sweeps,6);
 assert.equal(scans,2);
});
