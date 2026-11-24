import test from 'node:test';
import assert from 'node:assert/strict';
import {connect,type AddressInfo} from 'node:net';
import {startFiMeterLoopbackServer} from '../packages/dns-policy/src/fi-dns-meter-loopback.ts';

function frame(s:string):Buffer{
 const body=Buffer.from(s),head=Buffer.alloc(4);
 head.writeUInt32BE(body.length);return Buffer.concat([head,body]);
}
async function exchange(port:number,wire:Buffer):Promise<Buffer>{
 return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];
  const socket=connect({host:'127.0.0.1',port},()=>socket.write(wire));
  socket.setTimeout(3500,()=>socket.destroy(new Error('test timeout')));
  socket.on('data',b=>chunks.push(b));
  socket.on('error',e=>{if((e as NodeJS.ErrnoException).code!=='ECONNRESET')reject(e);});
  socket.on('close',()=>resolve(Buffer.concat(chunks)));
 });
}
test('private framed listener binds loopback and rejects duplicate, oversized and trailing frames',async()=>{
 let calls=0;
 const server=await startFiMeterLoopbackServer(0,async value=>{
  calls++;assert.deepEqual(value,{version:1});return {result:'RESERVED'};
 });
 try{
  const address=server.address() as AddressInfo;
  assert.equal(address.address,'127.0.0.1');
  const response=await exchange(address.port,frame('{"version":1}'));
  assert.equal(response.readUInt32BE(0),response.length-4);
  assert.deepEqual(JSON.parse(response.subarray(4).toString()),{result:'RESERVED'});
  const large=Buffer.alloc(4);large.writeUInt32BE(4097);
  for(const wire of [large,frame('{"version":1,"version":1}'),frame('{ "version":1}'),
                     Buffer.concat([frame('{"version":1}'),Buffer.from('x')])]){
   assert.equal((await exchange(address.port,wire)).length,0);
  }
  assert.equal(calls,1);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
