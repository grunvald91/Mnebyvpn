import test from 'node:test';
import assert from 'node:assert/strict';
import {eligibleNodes,isNodeEligible,assertNodeTransition,NODE_HEALTH_TTL_MS}
  from '../packages/nodes/src/registry.ts';
import type {NodeRecord} from '../packages/nodes/src/registry.ts';

const now=new Date('2026-11-07T08:00:00Z');
const base:NodeRecord={
  id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  code:'de-berlin-01',countryCode:'DE',kind:'normal',
  state:'verified',capabilities:['vless-ws-tls'],maxClients:100,
  allocatedClients:5,verifiedAt:new Date(now.getTime()-60000),
  operatorApprovedAt:new Date(now.getTime()-60000),
  lastProbeAt:new Date(now.getTime()-1000),
  lastHealthyAt:new Date(now.getTime()-1000),
  lastProbeOk:true,enabledForNew:true,
};
const request={capability:'vless-ws-tls',now};

test('only verified, manually approved, fresh and healthy nodes are candidates',()=>{
  assert.equal(isNodeEligible(base,request),true);
  const disallowed:Partial<NodeRecord>[]=[
    {state:'testing'},{state:'degraded'},{state:'draining'},
    {state:'disabled'},{operatorApprovedAt:null},{verifiedAt:null},
    {enabledForNew:false},{lastProbeOk:false},
    {lastProbeAt:new Date(now.getTime()-NODE_HEALTH_TTL_MS-1)},
    {lastHealthyAt:new Date(now.getTime()-NODE_HEALTH_TTL_MS-1)},
    {lastProbeAt:new Date(now.getTime()+1000)},
    {maxClients:5},{maxClients:null},{allocatedClients:-1},
    {capabilities:['wireguard']},
  ];
  for(const change of disallowed)
    assert.equal(isNodeEligible({...base,...change},request),false,
      'unsafe node must not be selected: '+JSON.stringify(change));
});
test('special nodes and regions require explicit request and verified capacity',()=>{
  const special={...base,kind:'special' as const};
  assert.equal(isNodeEligible(special,request),false);
  assert.equal(isNodeEligible(special,{...request,allowSpecial:true}),true);
  assert.equal(isNodeEligible(base,{...request,countryCode:'US'}),false);
  assert.equal(eligibleNodes([{...base,code:'z-node'},base],request)[0].code,base.code);
  assert.throws(()=>isNodeEligible(base,{capability:'../bad',now}));
});
test('lifecycle disallows skipping canary or silently returning to verified',()=>{
  assert.doesNotThrow(()=>assertNodeTransition('planned','testing'));
  assert.doesNotThrow(()=>assertNodeTransition('testing','canary'));
  assert.doesNotThrow(()=>assertNodeTransition('canary','verified'));
  assert.throws(()=>assertNodeTransition('planned','verified'));
  assert.throws(()=>assertNodeTransition('degraded','verified'));
  assert.throws(()=>assertNodeTransition('disabled','verified'));
  assert.doesNotThrow(()=>assertNodeTransition('draining','verified'));
});
