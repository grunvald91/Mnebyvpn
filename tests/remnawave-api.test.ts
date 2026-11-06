import test from 'node:test';
import assert from 'node:assert/strict';
import {RemnawaveApi,remnawaveUsername} from '../packages/provisioning/src/remnawave-api.ts';

const entitlement='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const username=remnawaveUsername(entitlement);
const squad='123e4567-e89b-42d3-a456-426614174000';
const expiry=new Date(Date.now()+48*3600_000);
const cfg={panelUrl:'https://panel.example.test/',subscriptionOrigin:'https://subs.example.test/',
  apiToken:'fake-but-long-enough-token-123',squadUuids:[squad]};
test('username is deterministic and cannot be injected into API route',()=>{
 assert.equal(username,'mb_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee');
 assert.throws(()=>remnawaveUsername('../api/users'));
 assert.throws(()=>new RemnawaveApi({...cfg,panelUrl:'https://panel.example.test/api'}));
 assert.throws(()=>new RemnawaveApi({...cfg,panelUrl:'http://nonloopback.example.test/'}));
 assert.throws(()=>new RemnawaveApi({...cfg,subscriptionOrigin:'http://subs.example.test/'}));
});
test('verified panel profile may be shown only for exact expiry and HTTPS host',async()=>{
 let current:any=null;
 const calls:{url:string;method:string;headers:HeadersInit|undefined}[]=[];
 const mock:typeof fetch=async(input,opts)=>{
  const u=new URL(String(input));
  const method=opts?.method??'GET';
  calls.push({url:u.href,method,headers:opts?.headers});
  assert.equal(u.origin,'https://panel.example.test');
  assert.ok(u.pathname.startsWith('/api/users'));
  if(method==='GET')return new Response(current?JSON.stringify({response:current}):'{}',
   {status:current?200:404});
  const payload=JSON.parse(String(opts?.body));
  if(method==='POST'){
   assert.deepEqual(payload.activeInternalSquads,[squad]);
   assert.equal(payload.status,'ACTIVE');
  }
  current={
   ...current,username:payload.username,status:payload.status,
   expireAt:payload.expireAt,description:payload.description,
   subscriptionUrl:'https://subs.example.test/profile/secret-token',
  };
  return Response.json({response:current},{status:method==='POST'?201:200});
 };
 const api=new RemnawaveApi(cfg,mock);
 assert.equal(await api.getByEntitlement(entitlement),null);
 await api.applyPanelChange(entitlement,1,true,expiry);
 assert.equal((await api.getByEntitlement(entitlement))?.status,'ACTIVE');
 assert.equal(await api.subscriptionFor(entitlement,expiry,1),current.subscriptionUrl);
 assert.equal(await api.subscriptionFor(entitlement,new Date(expiry.getTime()+10_000),1),null);
 current.subscriptionUrl='https://evil.example.test/steal';
 assert.equal(await api.subscriptionFor(entitlement,expiry,1),null);
 current.subscriptionUrl='https://subs.example.test.evil.tld/steal';
 assert.equal(await api.subscriptionFor(entitlement,expiry,1),null);
 current.subscriptionUrl='http://subs.example.test/steal';
 assert.equal(await api.subscriptionFor(entitlement,expiry,1),null);
 current.subscriptionUrl='https://subs.example.test/profile/secret-token';
 current.status='DISABLED';
 assert.equal(await api.subscriptionFor(entitlement,expiry,1),null);
 assert.ok(calls.some(x=>x.method==='POST'));
});
test('no active URL from panel if it cannot be read back',async()=>{
 const mock:typeof fetch=async()=>new Response('not found',{status:404});
 const api=new RemnawaveApi(cfg,mock);
 await assert.rejects(api.applyPanelChange(entitlement,1,true,expiry));
 assert.equal(await api.subscriptionFor(entitlement,expiry,1),null);
});
