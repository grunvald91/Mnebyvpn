import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RemnawaveProvisioningAdapter,parseRemnawaveObservation,
  validateHardExpiryEvidence,
} from '../packages/provisioning/src/remnawave-adapter.ts';
import type {RemnawaveUser} from '../packages/provisioning/src/remnawave-api.ts';

const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const username='mb_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee';
const now=new Date('2035-11-06T18:00:00.000Z');
const proof={
  reportSha256:'a'.repeat(64),panelVersion:'3.4.7',
  nodeVersion:'2.6.0',xrayVersion:'26.9.1',
};
const record=(revision:number,status='ACTIVE'):RemnawaveUser=>({
  username,status,expireAt:now.toISOString(),
  description:'mnebyvpn:'+id+':rev:'+revision,subscriptionUrl:null,id:11,
});
test('hard-expiry acceptance needs private report digest and all pinned versions',()=>{
  validateHardExpiryEvidence(proof);
  assert.throws(()=>validateHardExpiryEvidence({...proof,reportSha256:'operator says yes'}));
  assert.throws(()=>validateHardExpiryEvidence({...proof,nodeVersion:''}));
  assert.throws(()=>validateHardExpiryEvidence({...proof,xrayVersion:'26.9.1; curl attacker'}));
});
test('panel records must have exact entitlement ownership, monotonic revision and expiry',()=>{
  assert.deepEqual(parseRemnawaveObservation(id,null),
    {revision:0,enabled:false,expiresAt:null,absent:true});
  assert.deepEqual(parseRemnawaveObservation(id,record(2,'DISABLED')),{
    revision:2,enabled:false,expiresAt:now,
  });
  assert.deepEqual(parseRemnawaveObservation(id,record(1)),{
    revision:1,enabled:true,expiresAt:now,
  });
  assert.throws(()=>parseRemnawaveObservation(id,{...record(1),username:'mb_else'}));
  assert.throws(()=>parseRemnawaveObservation(id,{...record(1),description:'mnebyvpn:'+id+':rev:1xx'}));
  assert.throws(()=>parseRemnawaveObservation(id,{...record(1),description:'mnebyvpn:'+id+':rev:1:abc'}));
  assert.throws(()=>parseRemnawaveObservation(id,{...record(1),expireAt:'bad'}));
  assert.throws(()=>parseRemnawaveObservation(id,{...record(1),status:'UNKNOWN'}));
});
test('adapter applies allowed operations and rejects stale/replayed operation IDs',async()=>{
 let current:RemnawaveUser|null=null;
 const writes:string[]=[];
 const panel={
   getByEntitlement:async()=>current,
   applyPanelChange:async(_id:string,rev:number,enabled:boolean,expiry:Date|null)=>{
     writes.push(rev+':'+enabled);
     current={...record(rev,enabled?'ACTIVE':'DISABLED'),
       expireAt:(expiry??now).toISOString()};
     return current;
   },
 };
 const a=new RemnawaveProvisioningAdapter(panel,proof);
 const desired={entitlementId:id,revision:1,enabled:true,expiresAt:now};
 assert.equal('enforcesHardExpiry' in a,false,'panel read-back alone cannot confirm node expiry');
 assert.deepEqual(await a.inspect(id),{revision:0,enabled:false,expiresAt:null,absent:true});
 await assert.rejects(a.apply(desired,'bad'));
 assert.deepEqual(writes,[]);
 // The clock is before the 2035 deadline.
 assert.equal(await a.apply(desired,id+':1:enable'),'applied');
 assert.deepEqual(await a.inspect(id),{revision:1,enabled:true,expiresAt:now});
 assert.equal(await a.apply({...desired,revision:2,enabled:false,expiresAt:null},
   id+':2:disable'),'applied');
 assert.deepEqual(await a.inspect(id),{revision:2,enabled:false,expiresAt:now});
 assert.deepEqual(writes,['1:true','2:false']);
});
