import assert from 'node:assert/strict';
import test from 'node:test';
import {runAwgDeliveryLoop,deliverAwgCycle} from '../apps/service/src/awg-controller-delivery-worker.ts';

test('delivery loop handles one command at a time and shuts down',async()=>{
  const stop=new AbortController();
  let inflight=0,max=0,calls=0;
  const statuses:string[]=[];
  await runAwgDeliveryLoop(async()=>{
    inflight++;max=Math.max(max,inflight);calls++;
    await Promise.resolve();
    inflight--;
    if(calls===3)stop.abort();
    if(calls===1)return {status:'acknowledged',outboxId:'7'};
    return {status:'idle'};
  },stop.signal,async()=>{},s=>statuses.push(s));
  assert.equal(max,1);
  assert.equal(calls,3);
  assert.deepEqual(statuses,['acknowledged','idle','idle']);
});

test('transient failures do not leak details and three consecutive failures halt',async()=>{
  const stop=new AbortController();
  const statuses:string[]=[];
  let attempts=0;
  await assert.rejects(
    runAwgDeliveryLoop(async()=>{
      attempts++;
      throw Error('confidential SSH credential');
    },stop.signal,async()=>{},s=>statuses.push(s)),
    /Repeated trusted AWG delivery failures/,
  );
  assert.equal(attempts,3);
  assert.deepEqual(statuses,['error','error','error']);
});

test('successful delivery resets consecutive failure counter',async()=>{
  const stop=new AbortController();
  let count=0;
  const statuses:string[]=[];
  await runAwgDeliveryLoop(async()=>{
    count++;
    if(count===1||count===3)throw Error('transient');
    if(count===4)stop.abort();
    return {status:'idle'};
  },stop.signal,async()=>{},s=>statuses.push(s));
  assert.deepEqual(statuses,['error','idle','error','idle']);
});

test('aborted controller never attempts delivery',async()=>{
  const stop=new AbortController();
  stop.abort();
  await runAwgDeliveryLoop(async()=>{throw Error('unexpected');},
    stop.signal,async()=>{throw Error('unexpected');});
});


test('owner V2 delivery is strictly opt-in and serial after legacy worker',async()=>{
  const events:string[]=[];
  const legacy=async()=>{events.push('legacy');return {status:'acknowledged' as const,
    outboxId:'11'};};
  const owner=async()=>{events.push('owner');return {status:'acknowledged' as const,
    outboxId:'12'};};
  assert.deepEqual(await deliverAwgCycle(legacy,owner,false),
    {status:'acknowledged',outboxId:'11'});
  assert.deepEqual(events,['legacy'],'disabled flag must never call V2 transport');
  assert.deepEqual(await deliverAwgCycle(legacy,owner,true),
    {status:'acknowledged',outboxId:'12'});
  assert.deepEqual(events,['legacy','legacy','owner']);
  const idle=async()=>({status:'idle' as const});
  assert.deepEqual(await deliverAwgCycle(legacy,idle,true),
    {status:'acknowledged',outboxId:'11'},'idle V2 must not hide V1 ACK');
  await assert.rejects(
    deliverAwgCycle(legacy,async()=>{
      throw Error('V2 transport failure must propagate');
    },true),/V2 transport failure/);
});
