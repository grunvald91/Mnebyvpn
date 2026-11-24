import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,randomUUID,randomBytes} from 'node:crypto';
import {handleFiMeterRequest,signFiMeterRequest,verifyFiMeterDecision,type MeterRequest,type MeterDatabase} from '../packages/dns-policy/src/fi-dns-meter-rpc.ts';
const node=generateKeyPairSync('ed25519'),controller=generateKeyPairSync('ed25519');
const pin=(k:typeof node.publicKey)=>{
 const der=k.export({format:'der',type:'spki'});
 return {spki:der.toString('base64url'),sha256:createHash('sha256').update(der).digest('hex')};
};
const now=Date.parse('2026-11-24T12:00:00.000Z');
const clock=()=>now;
const request=(op:MeterRequest['op']='reserve'):MeterRequest=>({
 version:1,nodeId:'fi-test-01',countryCode:'FI',op,requestId:randomUUID(),
 tokenSha256:op==='reserve'?'a'.repeat(64):null,issuedAt:new Date(now).toISOString(),
 nonce:randomBytes(32).toString('hex'),
});

test('verified FI reserve reaches only the parameterized private RPC',async()=>{
 const req=request(),signed=signFiMeterRequest(req,node.privateKey,now);
 let calls=0;
 const db:MeterDatabase={query:async(sql,args)=>{
  calls++;assert.match(sql,/public\.fi_dns_meter_verified_apply/);
  assert.deepEqual(args,[req.op,req.requestId,req.tokenSha256,pin(node.publicKey).sha256,req.nonce,req.issuedAt]);
  return {rows:[{result:'RESERVED'}]};
 }};
 const decision=await handleFiMeterRequest(signed,pin(node.publicKey),controller.privateKey,db,clock);
 assert.equal(verifyFiMeterDecision(decision,req,pin(controller.publicKey),now).result,'RESERVED');
 assert.equal(calls,1);
 assert.throws(()=>verifyFiMeterDecision(decision,request(),pin(controller.publicKey),now));
 assert.throws(()=>verifyFiMeterDecision(decision,req,pin(node.publicKey),now));
 assert.throws(()=>verifyFiMeterDecision({...decision,result:'DENY_QUOTA'},req,pin(controller.publicKey),now));
 assert.throws(()=>verifyFiMeterDecision(decision,req,pin(controller.publicKey),now+16_000));
});

test('tampered, wrong key, stale or extra-field requests never reach SQL',async()=>{
 const req=request(),signed=signFiMeterRequest(req,node.privateKey,now);
 const db:MeterDatabase={query:async()=>{assert.fail('unverified request reached SQL');}};
 for(const bad of [{...signed,tokenSha256:'b'.repeat(64)},{...signed,countryCode:'DE'},
 {...signed,extra:'bearer'},{...signed,signature:'a'.repeat(86)},
 signFiMeterRequest(req,controller.privateKey,now)]){
  await assert.rejects(handleFiMeterRequest(bad,pin(node.publicKey),controller.privateKey,db,clock));
 }
 await assert.rejects(handleFiMeterRequest(signed,pin(node.publicKey),controller.privateKey,db,()=>now+16_000));
});

test('SQL failures and mismatched operation results cannot be signed as success',async()=>{
 const req=request('reserve'),signed=signFiMeterRequest(req,node.privateKey,now);
 for(const result of ['SETTLED','RELEASED','unknown',true,null]){
  await assert.rejects(handleFiMeterRequest(signed,pin(node.publicKey),controller.privateKey,
   {query:async()=>({rows:[{result}]})},clock));
 }
 await assert.rejects(handleFiMeterRequest(signed,pin(node.publicKey),controller.privateKey,
  {query:async()=>{throw Error('DB unavailable');}},clock));
 const denied=await handleFiMeterRequest(signed,pin(node.publicKey),controller.privateKey,
  {query:async()=>({rows:[{result:'DENY_REPLAY'}]})},clock);
 assert.equal(verifyFiMeterDecision(denied,req,pin(controller.publicKey),now).result,'DENY_REPLAY');
});
