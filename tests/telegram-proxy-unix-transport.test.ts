import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTelemtUnixTransport}
  from '../packages/web/src/telegram-proxy-unix-transport.ts';
import {TelemtAdminClient} from '../packages/web/src/telegram-proxy-provisioning.ts';

test('private Unix transport preserves HTTP/API schema and never opens TCP',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tmta-'));
  const socket=join(root,'api.sock');
  const calls:string[]=[];
  const server=createServer((req,res)=>{
    calls.push(req.method+' '+req.url);
    assert.equal(req.headers.authorization,'Bearer '+ 'a'.repeat(32));
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/users/dns_000000000000000000000000'){
      res.writeHead(404);res.end('');return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ok:true,data:{status:'ready'},revision:'a'.repeat(64)}));
  });
  try{
    await new Promise<void>((resolve,reject)=>server.listen(socket,()=>resolve()).once('error',reject));
    const transport=createTelemtUnixTransport(socket);
    const admin=new TelemtAdminClient('http://127.0.0.1:9096/',
      'Bearer '+ 'a'.repeat(32),transport);
    assert.equal(await admin.get('dns_000000000000000000000000'),null);
    const ok=await transport('http://127.0.0.1:9096/v1/system/info',{
      method:'GET',headers:{Authorization:'Bearer '+ 'a'.repeat(32)},
      signal:AbortSignal.timeout(1000),
    });
    assert.equal(ok.status,200);
    assert.equal((await ok.json()).ok,true);
    assert.deepEqual(calls,[
      'GET /v1/users/dns_000000000000000000000000',
      'GET /v1/system/info',
    ]);
    for(const dest of ['http://89.125.90.101:9096/v1/users',
      'http://127.0.0.1:9096/private',
      'http://127.0.0.1:9096/v1/users?token=foo',
      'https://127.0.0.1:9096/v1/users']){
      await assert.rejects(transport(dest),/Unexpected Telemt destination/);
    }
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
test('Unix transport rejects non-absolute and traversing paths',()=>{
  for(const path of ['', 'api.sock','/tmp/../users.sock','/tmp/x\0.sock']){
    assert.throws(()=>createTelemtUnixTransport(path),/Invalid local Telemt socket/);
  }
});
