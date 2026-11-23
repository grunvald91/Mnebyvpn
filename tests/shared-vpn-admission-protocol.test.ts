import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,type KeyObject} from 'node:crypto';
import {admissionRequestSha256,signNodeAdmissionRequest,verifyNodeAdmissionRequest,
  signControllerAdmissionDecision,verifyControllerAdmissionDecision,
  type AdmissionRequest,type AdmissionDecision,type SignedAdmissionRequest,
  type TrustedAdmissionIdentity,type ControllerAdmissionIdentity,
} from '../packages/provisioning/src/shared-vpn-admission-protocol.ts';

const ms=Date.parse('2026-11-23T14:00:00.000Z');
function pin(key:KeyObject){
 const der=key.export({format:'der',type:'spki'}) as Buffer;
 return {identityPublicSpki:der.toString('base64url'),
  identityPublicSha256:createHash('sha256').update(der).digest('hex')};
}
function request(nodeId='de-live',countryCode:'DE'|'FI'='DE'):AdmissionRequest{
 return {version:1,nodeId,countryCode,op:'claim',
  entitlementId:randomUUID(),connectionId:randomUUID(),
  peerSha256:'a'.repeat(64),issuedAt:new Date(ms).toISOString(),
  nonce:'b'.repeat(64)};
}
function decision(r:AdmissionRequest,result:'ADMITTED'|'DENY_LIMIT'|'RELEASED'='ADMITTED'):AdmissionDecision{
 return {version:1,nodeId:r.nodeId,countryCode:r.countryCode,op:r.op,
  entitlementId:r.entitlementId,connectionId:r.connectionId,
  peerSha256:r.peerSha256,requestSha256:admissionRequestSha256(r),
  result,decidedAt:new Date(ms).toISOString(),
  leaseUntil:result==='ADMITTED'?new Date(ms+40_000).toISOString():null};
}
test('two registered DE/FI node signatures cannot impersonate each other',()=>{
 const de=generateKeyPairSync('ed25519'),fi=generateKeyPairSync('ed25519');
 const dePin:TrustedAdmissionIdentity={nodeId:'de-live',countryCode:'DE',...pin(de.publicKey)};
 const fiPin:TrustedAdmissionIdentity={nodeId:'fi-test-01',countryCode:'FI',...pin(fi.publicKey)};
 const a=request(),b=request('fi-test-01','FI');
 const aSigned=signNodeAdmissionRequest(a,de.privateKey,ms);
 const bSigned=signNodeAdmissionRequest(b,fi.privateKey,ms);
 assert.deepEqual(verifyNodeAdmissionRequest(aSigned,dePin,ms),a);
 assert.deepEqual(verifyNodeAdmissionRequest(bSigned,fiPin,ms),b);
 assert.throws(()=>verifyNodeAdmissionRequest(aSigned,fiPin,ms));
 assert.throws(()=>verifyNodeAdmissionRequest(
  {...aSigned,countryCode:'FI'},dePin,ms));
 assert.throws(()=>verifyNodeAdmissionRequest(
  {...aSigned,signature:bSigned.signature},dePin,ms));
 assert.throws(()=>verifyNodeAdmissionRequest(
  {...aSigned,nodeId:'fi-test-01'},dePin,ms));
 assert.throws(()=>verifyNodeAdmissionRequest(
  {...aSigned,peerSha256:'c'.repeat(64)},dePin,ms));
 assert.throws(()=>verifyNodeAdmissionRequest(
  {...aSigned,op:'release'},dePin,ms));
 assert.throws(()=>verifyNodeAdmissionRequest(aSigned,{...dePin,identityPublicSha256:'0'.repeat(64)},ms));
});
test('replays outside max clock skew, malformed keys/nonce, extra fields are rejected',()=>{
 const node=generateKeyPairSync('ed25519');
 const identity:TrustedAdmissionIdentity={nodeId:'de-live',countryCode:'DE',...pin(node.publicKey)};
 const base=request();
 const signed=signNodeAdmissionRequest(base,node.privateKey,ms);
 assert.throws(()=>verifyNodeAdmissionRequest(signed,identity,ms+15_001));
 assert.throws(()=>verifyNodeAdmissionRequest(signed,identity,ms-15_001));
 assert.throws(()=>signNodeAdmissionRequest({...base,nonce:'0'.repeat(64)},node.privateKey,ms));
 assert.throws(()=>signNodeAdmissionRequest({...base,peerSha256:'0'.repeat(64)},node.privateKey,ms));
 assert.throws(()=>signNodeAdmissionRequest({...base,issuedAt:'2026-11-23T14:00:00Z'},node.privateKey,ms));
 assert.throws(()=>verifyNodeAdmissionRequest({...signed,extra:'ignored'} as SignedAdmissionRequest,identity,ms));
 assert.throws(()=>verifyNodeAdmissionRequest({...signed,signature:signed.signature+'='},identity,ms));
 // Exact duplicate request remains cryptographically valid. Production
 // MUST reserve its nonce in persistent DB and reject second use.
 assert.deepEqual(verifyNodeAdmissionRequest(signed,identity,ms),base);
 assert.deepEqual(verifyNodeAdmissionRequest(signed,identity,ms),base);
});
test('signed controller result is bound to exact request, region and <=45s local lease',()=>{
 const n=generateKeyPairSync('ed25519'),controller=generateKeyPairSync('ed25519');
 const requestDe=request();
 const id:ControllerAdmissionIdentity={...pin(controller.publicKey)};
 const d=decision(requestDe);
 const signed=signControllerAdmissionDecision(d,requestDe,controller.privateKey,ms);
 assert.deepEqual(verifyControllerAdmissionDecision(signed,requestDe,id,ms),d);
 assert.throws(()=>verifyControllerAdmissionDecision(signed,request('fi-test-01','FI'),id,ms));
 assert.throws(()=>verifyControllerAdmissionDecision(signed,{...requestDe,connectionId:randomUUID()},id,ms));
 assert.throws(()=>verifyControllerAdmissionDecision(
  {...signed,result:'DENY_LIMIT',leaseUntil:null},requestDe,id,ms));
 assert.throws(()=>verifyControllerAdmissionDecision(
  signed,requestDe,{...id,identityPublicSha256:pin(n.publicKey).identityPublicSha256},ms));
 assert.throws(()=>signControllerAdmissionDecision(
  {...d,leaseUntil:new Date(ms+45_001).toISOString()},requestDe,controller.privateKey,ms));
 assert.throws(()=>signControllerAdmissionDecision(
  {...d,leaseUntil:new Date(ms).toISOString()},requestDe,controller.privateKey,ms));
 assert.throws(()=>verifyControllerAdmissionDecision(signed,requestDe,id,ms+15_001));
 const denied=decision(requestDe,'DENY_LIMIT');
 const deniedSigned=signControllerAdmissionDecision(denied,requestDe,controller.privateKey,ms);
 assert.equal(verifyControllerAdmissionDecision(deniedSigned,requestDe,id,ms).leaseUntil,null);
 assert.throws(()=>signControllerAdmissionDecision({...denied,leaseUntil:new Date(ms+5_000).toISOString()},requestDe,controller.privateKey,ms));
 assert.throws(()=>signControllerAdmissionDecision({...d,result:'RELEASED',leaseUntil:null},requestDe,controller.privateKey,ms));
});
test('release receipt never authorizes traffic and cannot be replayed as a grant',()=>{
 const controller=generateKeyPairSync('ed25519');
 const id=pin(controller.publicKey);
 const r={...request('fi-test-01','FI'),op:'release' as const};
 const d={...decision(r,'RELEASED'),leaseUntil:null};
 const signed=signControllerAdmissionDecision(d,r,controller.privateKey,ms);
 assert.equal(verifyControllerAdmissionDecision(signed,r,id,ms).result,'RELEASED');
 assert.throws(()=>signControllerAdmissionDecision({
  ...d,result:'ADMITTED',leaseUntil:new Date(ms+5_000).toISOString(),
 },r,controller.privateKey,ms));
 const admission={...r,op:'claim' as const};
 assert.throws(()=>verifyControllerAdmissionDecision(signed,admission,id,ms));
});
