import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {decideSharedVpnAdmission} from '../packages/provisioning/src/shared-vpn-admission-controller.ts';
import {signNodeAdmissionRequest,verifyControllerAdmissionDecision,type AdmissionRequest} from '../packages/provisioning/src/shared-vpn-admission-protocol.ts';

test('gateway signs exact committed deadline only for a verified node',async()=>{
 const node=generateKeyPairSync('ed25519'),controller=generateKeyPairSync('ed25519');
 const pin=(key:typeof node.publicKey)=>{
   const raw=key.export({format:'der',type:'spki'});
   return {identityPublicSpki:raw.toString('base64url'),identityPublicSha256:createHash('sha256').update(raw).digest('hex')};
 };
 const ms=Date.parse('2026-11-28T20:00:00.000Z');
 const r:AdmissionRequest={version:1,nodeId:'fi-test-01',countryCode:'FI',op:'claim',
  entitlementId:randomUUID(),connectionId:randomUUID(),peerSha256:'a'.repeat(64),
  issuedAt:new Date(ms).toISOString(),nonce:'b'.repeat(64)};
 const signed=signNodeAdmissionRequest(r,node.privateKey,ms);
 const deadline=new Date(ms+12_345).toISOString();
 let writes=0;
 let result={result:'ADMITTED',leaseUntil:deadline as string|null};
 const db={query:async(sql:string,args:unknown[])=>{
   if(sql.includes('node_identity'))return {rows:[{identity:{nodeId:r.nodeId,countryCode:r.countryCode,...pin(node.publicKey)}}]};
   writes++;
   assert.equal(args[0],r.entitlementId);assert.equal(args[4],r.op);
   assert.equal(args[8],pin(node.publicKey).identityPublicSha256);
   return {rows:[{decision:result}]};
 }} as unknown as Pick<Pool,'query'>;
 const call=(env:unknown=signed)=>decideSharedVpnAdmission(db,env,controller.privateKey,()=>ms);
 const decision=await call();
 assert.equal(verifyControllerAdmissionDecision(decision,r,pin(controller.publicKey),ms).leaseUntil,deadline);
 assert.equal(writes,1);
 await assert.rejects(call({...signed,peerSha256:'c'.repeat(64)}));
 assert.equal(writes,1,'untrusted request must never mutate ledger');
 result={result:'DENY_LIMIT',leaseUntil:null};
 assert.equal((await call()).result,'DENY_LIMIT');
 result={result:'ADMITTED',leaseUntil:new Date(ms+45_001).toISOString()};
 await assert.rejects(call());
 result={result:'REFRESHED',leaseUntil:deadline};
 await assert.rejects(call());
 result={result:'DENY_PEER',leaseUntil:deadline};
 await assert.rejects(call());
});
