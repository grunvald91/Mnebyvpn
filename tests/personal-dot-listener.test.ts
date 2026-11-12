import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {connect as connectTls} from 'node:tls';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {Pool} from 'pg';
import {createPersonalDotListener} from '../packages/dns-policy/src/personal-dot-listener.ts';

const dir=mkdtempSync(join(tmpdir(),'dot-private-'));
const keyFile=join(dir,'key.pem'),certFile=join(dir,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes',
  '-keyout',keyFile,'-out',certFile,'-days','1',
  '-subj','/CN=*.dns.mnebyvpn.site','-addext','subjectAltName=DNS:*.dns.mnebyvpn.site'],
  {stdio:'ignore'});
const key=readFileSync(keyFile),cert=readFileSync(certFile);
process.once('exit',()=>rmSync(dir,{recursive:true,force:true}));
const hostname='abcdefghijkl.dns.mnebyvpn.site';

function request(domain:string):Buffer{
  const header=Buffer.alloc(12);
  header.writeUInt16BE(42,0);header.writeUInt16BE(0x0100,2);header.writeUInt16BE(1,4);
  const labels=domain.split('.').map(x=>Buffer.concat([Buffer.from([x.length]),Buffer.from(x)]));
  return Buffer.concat([header,...labels,Buffer.from([0,0,1,0,1])]);
}
function answer(q:Uint8Array):Uint8Array{
  const a=Buffer.from(q);a.writeUInt16BE(0x8180,2);return a;
}
function frame(q:Uint8Array):Buffer{
  const f=Buffer.alloc(q.length+2);f.writeUInt16BE(q.length,0);f.set(q,2);return f;
}
test('personal DoT server accepts framed TLS requests, meters mapped only and disables rotated identity',async()=>{
  let known=true,debits=0,direct=0,mapped=0;
  const db={query:async(sql:string)=>{
    if(sql.includes('recognize_personal_dns_credential'))return{rows:[{known}]};
    if(sql.includes('consume_personal_dns_query')){debits++;return{rows:[{verdict:'ALLOWED'}]};}
    throw Error('unexpected SQL');
  }} as unknown as Pick<Pool,'query'>;
  const server=createPersonalDotListener({key,cert,db,queryTimeoutMs:2000,
    classify:q=>q.name==='claude.ai'?'premium':'direct',
    mapped:async q=>{mapped++;return answer(q);},
    direct:async q=>{direct++;return answer(q);},
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as AddressInfo).port;
  const sock=connectTls({host:'127.0.0.1',port,servername:hostname,rejectUnauthorized:false});
  sock.on('error',()=>{});
  try{
    await once(sock,'secureConnect');
    const reads:Buffer[]=[];
    sock.on('data',(chunk:Buffer)=>reads.push(chunk));
    async function send(q:Buffer):Promise<void>{
      sock.write(frame(q));
      for(let i=0;i<70;i++){
        if(reads.reduce((n,b)=>n+b.length,0)>=q.length+2)return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      throw Error('DNS/TLS response timeout');
    }
    await send(request('example.org'));
    assert.equal(direct,1);assert.equal(debits,0);
    reads.length=0;
    await send(request('claude.ai'));
    assert.equal(mapped,1);assert.equal(debits,1);
    reads.length=0;
    known=false; // rotation invalidates even preexisting TLS sessions.
    sock.write(frame(request('example.org')));
    await once(sock,'close');
    assert.equal(direct,1);assert.equal(debits,1);
  }finally{
    sock.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
test('listener refuses certificate not covering the customer wildcard',()=>{
  assert.throws(()=>createPersonalDotListener({
    key,cert:Buffer.from('not a certificate'),db:{} as Pick<Pool,'query'>,
    classify:()=> 'direct',mapped:async()=>new Uint8Array(),
    direct:async()=>new Uint8Array(),
  }));
});
