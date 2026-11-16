import test from 'node:test';
import assert from 'node:assert/strict';
import {TelemtAdminClient,validateProxyProvisionConfig}
  from '../packages/web/src/telegram-proxy-provisioning.ts';

const name='dns_0123456789abcdef01234567';
const secret='a'.repeat(32);
const expiry=new Date('2030-01-05T00:00:00Z');
const state={username:name,enabled:true,in_runtime:true,
  expiration_rfc3339:expiry.toISOString()};
test('Telemt admin never accepts non-loopback destinations or unauthenticated operation',()=>{
  for(const target of ['http://example.com:9096/','https://127.0.0.1:9096/',
    'http://127.0.0.1:9096/extra','http://127.0.0.1:9096/?url=x'])
    assert.throws(()=>new TelemtAdminClient(target,'Bearer '+secret));
  assert.throws(()=>new TelemtAdminClient('http://127.0.0.1:9096/',''));
  assert.doesNotThrow(()=>new TelemtAdminClient('http://127.0.0.1:9096/','Bearer '+secret));
  assert.doesNotThrow(()=>validateProxyProvisionConfig('b'.repeat(64),'xapi.ozon.ru'));
  assert.throws(()=>validateProxyProvisionConfig('x','xapi.ozon.ru'));
  assert.throws(()=>validateProxyProvisionConfig('b'.repeat(64),'localhost'));
});
test('new user: provision with personal secret and verify effective runtime identity',async()=>{
  const calls:string[]=[];
  const transport=(async(url:string,init?:RequestInit)=>{
    const request=new URL(url),method=init?.method||'';
    assert.equal(request.hostname,'127.0.0.1');
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+secret);
    calls.push(method+' '+request.pathname);
    if(method==='GET'&&calls.length===1)return new Response('Not found',{status:404});
    if(method==='POST') {
      const body=JSON.parse(String(init?.body));
      assert.equal(body.username,name);
      assert.equal(body.secret,secret);
      assert.equal(body.expiration_rfc3339,expiry.toISOString());
      return new Response(JSON.stringify({ok:true,data:{user:state,secret}}),{status:201});
    }
    return new Response(JSON.stringify({ok:true,data:state}),{status:200});
  }) as typeof fetch;
  const admin=new TelemtAdminClient('http://127.0.0.1:9096/','Bearer '+secret,transport);
  assert.equal(await admin.ensure(name,secret,expiry,false),true);
  assert.deepEqual(calls,['GET /v1/users/'+name,'POST /v1/users',
    'GET /v1/users/'+name]);
});
test('existing user: rotate only when needed; disable and verify server state',async()=>{
  const calls:string[]=[];
  let disabled=false;
  const transport=(async(url:string,init?:RequestInit)=>{
    const path=new URL(url).pathname,method=init?.method;
    calls.push(method+' '+path);
    if(method==='POST')disabled=true;
    return new Response(JSON.stringify({ok:true,data:{...state,enabled:!disabled}}),{status:200});
  }) as typeof fetch;
  const admin=new TelemtAdminClient('http://127.0.0.1:9096/','Bearer '+secret,transport);
  assert.equal(await admin.ensure(name,secret,expiry,false),true);
  assert.deepEqual(calls,['GET /v1/users/'+name]);
  assert.equal(await admin.disable(name),true);
  assert.deepEqual(calls.slice(1),['GET /v1/users/'+name,
    'POST /v1/users/'+name+'/disable','GET /v1/users/'+name]);
});
test('unknown remote user is treated as already disabled',async()=>{
  const transport=(async()=>new Response('',{status:404})) as typeof fetch;
  const admin=new TelemtAdminClient('http://127.0.0.1:9096/','Bearer '+secret,transport);
  assert.equal(await admin.disable(name),true);
});

test('Telemt rejects bare or false-success JSON envelopes, not just HTTP errors',async()=>{
  const candidates=[JSON.stringify(state),JSON.stringify({ok:false,data:state}),
    JSON.stringify({ok:true}),JSON.stringify({ok:true,data:[]})];
  for(const candidate of candidates){
    const transport=(async()=>new Response(candidate,{status:200})) as typeof fetch;
    const admin=new TelemtAdminClient('http://127.0.0.1:9096/','Bearer '+secret,transport);
    await assert.rejects(admin.get(name),/Telemt success envelope missing/);
  }
});
