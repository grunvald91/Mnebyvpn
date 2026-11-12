import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer as createTlsServer,type Server as TlsServer} from 'node:tls';
import type {AddressInfo} from 'node:net';
import {queryVerifiedDotTls} from '../packages/dns-policy/src/verified-dot-upstream.ts';

const dir=mkdtempSync(join(tmpdir(),'dot-verified-'));
const keyFile=join(dir,'key.pem'),certFile=join(dir,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes',
 '-keyout',keyFile,'-out',certFile,'-days','1',
 '-subj','/CN=*.dns.mnebyvpn.site','-addext','subjectAltName=DNS:*.dns.mnebyvpn.site'],
 {stdio:'ignore'});
const key=readFileSync(keyFile),cert=readFileSync(certFile);
process.once('exit',()=>rmSync(dir,{recursive:true,force:true}));
const hostname='abcdefghijkl.dns.mnebyvpn.site';
const packet=(name:string)=>{
 const header=Buffer.alloc(12);
 header.writeUInt16BE(1042,0);header.writeUInt16BE(0x0100,2);header.writeUInt16BE(1,4);
 return Buffer.concat([header,...name.split('.').map(x=>
  Buffer.concat([Buffer.from([x.length]),Buffer.from(x)])),Buffer.from([0,0,1,0,1])]);
};
const reply=(q:Buffer)=>{const result=Buffer.from(q);result.writeUInt16BE(0x8180,2);return result;};
async function upstream(behavior:'normal'|'wrong-domain'|'hang'):Promise<{server:TlsServer,port:number}>{
 const server=createTlsServer({key,cert},socket=>{
  let buffer=Buffer.alloc(0);
  socket.on('error',()=>{});
  socket.on('data',(chunk:Buffer)=>{
   buffer=Buffer.concat([buffer,chunk]);
   if(buffer.length<2)return;
   const n=buffer.readUInt16BE(0);
   if(buffer.length<n+2)return;
   if(behavior==='hang')return;
   const q=behavior==='wrong-domain'?packet('wrong.example'):Buffer.from(buffer.subarray(2,n+2));
   const response=reply(q);
   const framed=Buffer.alloc(response.length+2);
   framed.writeUInt16BE(response.length,0);response.copy(framed,2);
   socket.end(framed);
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{server,port:(server.address() as AddressInfo).port};
}
async function shutdown(server:TlsServer){
 server.closeAllConnections?.();
 await new Promise<void>(resolve=>server.close(()=>resolve()));
}
test('verified upstream returns framed DNS only over trusted TLS with matching hostname',async()=>{
 const {server,port}=await upstream('normal');
 try{
  const query=packet('claude.ai');
  const result=await queryVerifiedDotTls({address:'127.0.0.1',port,servername:hostname,ca:cert},query);
  assert.equal(Buffer.from(result).readUInt16BE(0),1042);
  assert.equal(Buffer.from(result).readUInt16BE(2)&15,0);
 }finally{await shutdown(server);}
});
test('verified upstream rejects wrong TLS hostname, untrusted cert and QNAME mismatch',async()=>{
 const {server,port}=await upstream('wrong-domain');
 try{
  const request=packet('claude.ai');
  await assert.rejects(queryVerifiedDotTls({address:'127.0.0.1',port,
   servername:'other.invalid.test',ca:cert},request),/certificate rejected/);
  await assert.rejects(queryVerifiedDotTls({address:'127.0.0.1',port,
   servername:hostname},request),/certificate rejected/);
  await assert.rejects(queryVerifiedDotTls({address:'127.0.0.1',port,
   servername:hostname,ca:cert},request),/unrelated question/);
 }finally{await shutdown(server);}
});
test('verified upstream aborts a hanging TLS resolver and refuses hostnames without IP pin',async()=>{
 const {server,port}=await upstream('hang');
 try{
  const signal=new AbortController();
  const query=queryVerifiedDotTls({address:'127.0.0.1',port,servername:hostname,ca:cert},
   packet('claude.ai'),1000,signal.signal);
  setTimeout(()=>signal.abort(),40);
  await assert.rejects(query,/aborted/);
  await assert.rejects(queryVerifiedDotTls({address:'localhost',port,
   servername:hostname,ca:cert},packet('claude.ai')),/Invalid or cancelled/);
 }finally{await shutdown(server);}
});
