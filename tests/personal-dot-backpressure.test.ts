import test from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {writeDnsFrameWithBackpressure} from '../packages/dns-policy/src/personal-dot-listener.ts';

function stalledWritable(){
  let release:(err?:Error|null)=>void=()=>{};
  const stream=new Writable({
    highWaterMark:1,
    write(_chunk,_encoding,callback){release=callback;},
  });
  return{stream,flush:()=>release()};
}

test('write(false) keeps the accepted DNS frame and resumes after drain',async()=>{
  const {stream,flush}=stalledWritable();
  const frame=Buffer.alloc(80,2);
  let completed=false;
  const response=writeDnsFrameWithBackpressure(stream,frame,500);
  void response.then(()=>{completed=true;});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(completed,false,'must not destroy the connection just because write returned false');
  assert.equal(stream.destroyed,false);
  flush();
  assert.equal(await response,true,'drain must permit further DNS messages');
  assert.equal(stream.destroyed,false);
  stream.destroy();
});

test('a client that never drains is rejected after a bounded timeout',async()=>{
  const {stream}=stalledWritable();
  const start=performance.now();
  const response=await writeDnsFrameWithBackpressure(stream,Buffer.alloc(80,3),40);
  assert.equal(response,false);
  assert.ok(performance.now()-start<400,'deadline must be bounded');
  stream.destroy();
});

test('a closed socket fails promptly while waiting for drain',async()=>{
  const {stream}=stalledWritable();
  const response=writeDnsFrameWithBackpressure(stream,Buffer.alloc(80,3),1000);
  stream.destroy();
  assert.equal(await response,false);
});

test('buffer ceiling rejects oversized queued writes without calling write()',async()=>{
  let wrote=0;
  const stream=new Writable({
    highWaterMark:1,
    write(_chunk,_encoding,callback){wrote++;callback();},
  });
  assert.equal(await writeDnsFrameWithBackpressure(stream,Buffer.alloc(16387),40),false);
  assert.equal(wrote,0);
  stream.destroy();
});
