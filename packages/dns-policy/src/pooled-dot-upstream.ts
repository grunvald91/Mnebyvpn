/** Bounded reusable DoT transport. One in-flight DNS question per TLS socket.
 * A timeout/cancel/malformed reply discards that socket; queries are never
 * retried silently. Authorization and quota settlement stay outside this pool.
 */
import {randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {connect,type TLSSocket} from 'node:tls';
import {dnsResponseMatchesQuestion,parseDnsQuestion} from './personal-dot-gateway-core.ts';
import type {VerifiedDotUpstream} from './verified-dot-upstream.ts';
const MAX_DNS=16384;
type Task={question:Buffer;sent?:Buffer;done:boolean;resolve:(v:Uint8Array)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;signal?:AbortSignal;abort:()=>void;channel?:Channel};
type Channel={socket:TLSSocket;connected:boolean;closed:boolean;buffer:Buffer;task?:Task;idleTimer?:NodeJS.Timeout;born:number;messages:number;nextId:number;certUntil:number};
export type DotPoolOptions={maxConnections?:number;maxQueued?:number;idleMs?:number};
export function createVerifiedDotPool(upstream:VerifiedDotUpstream,options:DotPoolOptions={}){
  const maxConnections=options.maxConnections??4,maxQueued=options.maxQueued??32,idleMs=options.idleMs??30000;
  if(isIP(upstream.address)===0||!/^[a-z0-9](?:[a-z0-9.-]{1,251})[a-z0-9]$/i.test(upstream.servername)||upstream.servername.includes('..')||
    !Number.isSafeInteger(upstream.port)||upstream.port<1||upstream.port>65535||
    !Number.isSafeInteger(maxConnections)||maxConnections<1||maxConnections>8||
    !Number.isSafeInteger(maxQueued)||maxQueued<1||maxQueued>128||
    !Number.isSafeInteger(idleMs)||idleMs<10||idleMs>300000)throw Error('Invalid verified DoT pool configuration');
  const target={...upstream};
  const channels=new Set<Channel>(),queue:Task[]=[];
  let closed=false,handshakes=0;
  function settle(task:Task,error?:Error,answer?:Buffer){
    if(task.done)return;
    task.done=true;clearTimeout(task.timer);task.signal?.removeEventListener('abort',task.abort);task.channel=undefined;
    if(error)task.reject(error);else if(answer)task.resolve(answer);else task.reject(Error('Missing pooled DNS response'));
  }
  function discard(c:Channel,error=Error('Verified DoT upstream disconnected')){
    if(c.closed)return;
    c.closed=true;channels.delete(c);if(c.idleTimer)clearTimeout(c.idleTimer);c.socket.destroy();
    const task=c.task;c.task=undefined;c.buffer=Buffer.alloc(0);
    if(task)settle(task,error);
    pump();
  }
  function send(c:Channel){
    const task=c.task;if(!task||c.closed||!c.connected)return;
    if(!c.socket.authorized||c.certUntil<=Date.now()){discard(c,Error('Unverified pooled DoT certificate'));return;}
    const sent=Buffer.from(task.question);sent.writeUInt16BE(c.nextId);c.nextId=(c.nextId+1)&65535;c.messages++;
    task.sent=sent;
    const frame=Buffer.alloc(sent.length+2);frame.writeUInt16BE(sent.length);sent.copy(frame,2);
    if(c.socket.writableLength>MAX_DNS+2){discard(c,Error('Pooled DoT backpressure limit'));return;}
    try{c.socket.write(frame);}catch{discard(c,Error('Pooled DoT write failed'));}
  }
  function assign(c:Channel,task:Task){
    if(c.idleTimer)clearTimeout(c.idleTimer);c.idleTimer=undefined;
    c.task=task;task.channel=c;c.socket.ref();send(c);
  }
  function open(task:Task){
    const socket=connect({host:target.address,port:target.port,servername:target.servername,rejectUnauthorized:true,minVersion:'TLSv1.2',...(target.ca?{ca:target.ca}:{})});
    const c:Channel={socket,connected:false,closed:false,buffer:Buffer.alloc(0),born:Date.now(),messages:0,nextId:randomBytes(2).readUInt16BE(),certUntil:0};
    channels.add(c);assign(c,task);socket.setKeepAlive(true,15000);
    socket.on('secureConnect',()=>{
      if(c.closed)return;
      c.certUntil=Date.parse(socket.getPeerCertificate().valid_to);
      if(!socket.authorized||!Number.isFinite(c.certUntil)||c.certUntil<=Date.now()){discard(c,Error('Pooled DoT certificate rejected'));return;}
      c.connected=true;handshakes++;send(c);
    });
    socket.on('error',()=>discard(c,Error('Verified DoT TLS connection failed')));
    socket.on('close',()=>discard(c));
    socket.on('data',(part:Buffer)=>{
      if(c.closed)return;
      if(!c.task||!c.task.sent){discard(c,Error('Unsolicited pooled DNS response'));return;}
      if(c.buffer.length+part.length>MAX_DNS+2){discard(c,Error('Oversized pooled DNS response'));return;}
      c.buffer=Buffer.concat([c.buffer,part]);if(c.buffer.length<2)return;
      const size=c.buffer.readUInt16BE(0);
      if(size<17||size>MAX_DNS){discard(c,Error('Invalid pooled DNS response length'));return;}
      if(c.buffer.length<size+2)return;
      const answer=Buffer.from(c.buffer.subarray(2));const task=c.task;
      if(c.buffer.length!==size+2||!dnsResponseMatchesQuestion(task.sent!,answer)){discard(c,Error('Unmatched pooled DNS response'));return;}
      answer.writeUInt16BE(task.question.readUInt16BE());c.task=undefined;c.buffer=Buffer.alloc(0);settle(task,undefined,answer);
      // Fresh verification at least every five minutes / 4096 messages.
      // IDs cannot repeat on the same connection within that message bound.
      if(c.messages>=4096||Date.now()-c.born>=300000||c.certUntil<=Date.now())discard(c);
      else{c.socket.unref();c.idleTimer=setTimeout(()=>discard(c),idleMs);c.idleTimer.unref();pump();}
    });
  }
  function pump(){
    if(closed)return;
    for(const c of [...channels])if(c.connected&&!c.task&&(Date.now()-c.born>=300000||c.certUntil<=Date.now()))discard(c);
    while(queue.length){
      const idle=[...channels].find(c=>c.connected&&!c.closed&&!c.task&&Date.now()-c.born<300000&&c.certUntil>Date.now());
      if(idle){assign(idle,queue.shift()!);continue;}
      if(channels.size<maxConnections){open(queue.shift()!);continue;}
      break;
    }
  }
  function query(wire:Uint8Array,timeoutMs=3500,signal?:AbortSignal):Promise<Uint8Array>{
    if(closed||!(wire instanceof Uint8Array)||wire.length>MAX_DNS||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000||signal?.aborted)
      return Promise.reject(Error('Invalid or cancelled pooled DNS request'));
    try{parseDnsQuestion(wire);}catch{return Promise.reject(Error('Invalid pooled DNS question'));}
    if(queue.length>=maxQueued)return Promise.reject(Error('Pooled DoT queue is full'));
    return new Promise((resolve,reject)=>{
      const task:Task={question:Buffer.from(wire),done:false,resolve,reject,timer:undefined!,signal,abort:()=>cancel(Error('Pooled DoT request aborted'))};
      const cancel=(error:Error)=>{
        if(task.done)return;
        if(task.channel)discard(task.channel,error);
        else{const index=queue.indexOf(task);if(index>=0)queue.splice(index,1);settle(task,error);pump();}
      };
      task.timer=setTimeout(()=>cancel(Error('Pooled DoT request timeout')),timeoutMs);
      signal?.addEventListener('abort',task.abort,{once:true});
      if(signal?.aborted){task.abort();return;}
      queue.push(task);pump();
    });
  }
  function close(){
    if(closed)return;closed=true;
    for(const c of [...channels])discard(c,Error('Verified DoT pool closed'));
    for(const task of queue.splice(0))settle(task,Error('Verified DoT pool closed'));
  }
  return {query,close,stats:()=>({connections:channels.size,busy:[...channels].filter(c=>c.task).length,queued:queue.length,handshakes})};
}
