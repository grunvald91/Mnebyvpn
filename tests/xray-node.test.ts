import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {SignedXrayNodeApi,makeVpnImportUri,makeVpnRealityImportUri,parseNodeRecord}
  from '../packages/provisioning/src/xray-node.ts';

const key='1f'.repeat(32);
const entitlement='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const credential='12222222-3333-4333-8333-555555555555';
const expiry=new Date(Date.now()+24*3600000);

test('node endpoint and HMAC are exact, never unencrypted public control',async()=>{
 let state:any={revision:0,enabled:false,expiresAt:null};
 let calls=0;
 const mock:typeof fetch=async(input,opts)=>{
  assert.equal(String(input),'http://10.66.77.1:18944/v1/provision');
  assert.equal(opts?.method,'POST');
  assert.equal(opts?.redirect,'error');
  const body=String(opts?.body);
  const headers=opts?.headers as Record<string,string>;
  assert.equal(headers['X-Mnebyvpn-Signature'],
   createHmac('sha256',Buffer.from(key,'hex')).update(body).digest('hex'));
  const request=JSON.parse(body);
  assert.ok(Math.abs(Date.now()/1000-request.ts)<5);
  assert.equal(request.id,entitlement);
  calls++;
  if(request.op==='inspect')return Response.json(state,{headers:{Date:new Date().toUTCString()}});
  assert.equal(request.op,'apply');
  state={revision:request.revision,enabled:request.enabled,
   expiresAt:request.enabled?request.expiresAt:null,
   credential:request.enabled?credential:null};
  return Response.json({status:'applied',revision:request.revision},{headers:{Date:new Date().toUTCString()}});
 };
 const node=new SignedXrayNodeApi(key,mock);
 assert.equal(node.enforcesHardExpiry,true);
 assert.deepEqual(await node.inspect(entitlement),{revision:0,enabled:false,
   expiresAt:null,credential:null});
 const desired={entitlementId:entitlement,revision:1,enabled:true,expiresAt:expiry};
 assert.equal(await node.apply(desired,entitlement+':1:enable'),'applied');
 assert.equal((await node.inspect(entitlement)).enabled,true);
 const link=await node.profileFor(entitlement,1,expiry);
 assert.equal(link,makeVpnImportUri(credential));
 assert.ok(link?.includes('security=tls'));
 assert.ok(link?.includes('type=ws'));
 assert.equal(await node.profileFor(entitlement,2,expiry),null);
 assert.equal(await node.profileFor(entitlement,1,new Date(expiry.getTime()+9000)),null);
 const revoke={...desired,revision:2,enabled:false,expiresAt:null};
 assert.equal(await node.apply(revoke,entitlement+':2:disable'),'applied');
 assert.equal(await node.profileFor(entitlement,2,expiry),null);
 assert.ok(calls>=7);
});

test('unsafe or inconsistent remote state fails closed',async()=>{
 assert.throws(()=>new SignedXrayNodeApi('not-a-secret'));
 assert.throws(()=>makeVpnImportUri('abc'));
 assert.throws(()=>parseNodeRecord({revision:2,enabled:true,expiresAt:expiry.toISOString()}));
 assert.throws(()=>parseNodeRecord({revision:2,enabled:true,expiresAt:'bad',credential}));
 assert.throws(()=>parseNodeRecord({revision:-1,enabled:false,expiresAt:null}));
 const stale:typeof fetch=async()=>Response.json({status:'stale',revision:99},{headers:{Date:new Date().toUTCString()}});
 const api=new SignedXrayNodeApi(key,stale);
 assert.equal(await api.apply({entitlementId:entitlement,revision:2,
   enabled:false,expiresAt:null},entitlement+':2:disable'),'unknown');
 await assert.rejects(api.apply({entitlementId:entitlement,revision:2,
   enabled:false,expiresAt:null},entitlement+':1:enable'));
 const fail:typeof fetch=async()=>new Response('{}',{status:503,headers:{Date:new Date().toUTCString()}});
 await assert.rejects(new SignedXrayNodeApi(key,fail).inspect(entitlement),
   /HTTP 503/);
});

test('31-second foreign-node clock skew is compensated for exact 24h deadline',async()=>{
 let current:any={revision:0,enabled:false,expiresAt:null};
 let submittedDeadline='';
 const skewMs=-31_000;
 const remote:typeof fetch=async(_input,opts)=>{
   const nowHeader=new Date(Date.now()+skewMs).toUTCString();
   const body=JSON.parse(String(opts?.body));
   if(body.op==='inspect')
     return Response.json(current,{headers:{Date:nowHeader}});
   submittedDeadline=body.expiresAt;
   current={revision:body.revision,enabled:true,
     expiresAt:body.expiresAt,credential};
   return Response.json({status:'applied',revision:body.revision},
     {headers:{Date:nowHeader}});
 };
 const api=new SignedXrayNodeApi(key,remote);
 const desired={entitlementId:entitlement,revision:7,
   enabled:true,expiresAt:new Date(Date.now()+86400_000)};
 assert.equal(await api.apply(desired,entitlement+':7:enable'),'applied');
 const appliedMs=Date.parse(submittedDeadline);
 assert.ok(Math.abs((appliedMs-desired.expiresAt.getTime())-skewMs)<=1500,
   'node must receive deadline in its own clock frame');
 assert.equal((await api.inspect(entitlement)).revision,7);
 assert.equal(await api.profileFor(entitlement,7,desired.expiresAt),
   makeVpnImportUri(credential));
});

test('node advertises validated REALITY profile first with safe WS fallback',async()=>{
 const reality={publicKey:'A'.repeat(43),shortId:'ab12cd34ef56a789',port:2053};
 const record=parseNodeRecord({revision:3,enabled:true,
   expiresAt:expiry.toISOString(),credential,reality});
 assert.deepEqual(record.reality,reality);
 const fast=makeVpnRealityImportUri(credential,reality);
 assert.match(fast,/security=reality/);
 assert.match(fast,/flow=xtls-rprx-vision/);
 assert.match(fast,/sni=www.cloudflare.com/);
 assert.match(fast,/sid=ab12cd34ef56a789/);
 const fetcher:typeof fetch=async()=>Response.json({revision:3,enabled:true,
   expiresAt:expiry.toISOString(),credential,reality},
   {headers:{Date:new Date().toUTCString()}});
 const api=new SignedXrayNodeApi(key,fetcher);
 assert.equal(await api.profileFor(entitlement,3,expiry),
   fast+'\n'+makeVpnImportUri(credential));
 for(const invalid of [
   {...reality,shortId:'x'},
   {...reality,publicKey:'malformed'},
   {...reality,port:8443},
 ])assert.throws(()=>parseNodeRecord({revision:3,enabled:true,
   expiresAt:expiry.toISOString(),credential,reality:invalid}));
});
