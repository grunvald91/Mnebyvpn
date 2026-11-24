/** Bounded reusable DoT transport. One in-flight DNS question per TLS socket.
 * A stale reused idle socket closing before any reply bytes may retry once on
 * a fresh socket; timeouts, cancellations, and malformed replies never retry.
 * Authorization and quota settlement stay outside this pool.
 */
import {randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {connect,type TLSSocket} from 'node:tls';
import {dnsResponseMatchesQuestion,parseDnsQuestion} from './personal-dot-gateway-core.ts';
import type {VerifiedDotUpstream} from './verified-dot-upstream.ts';
const MAX_DNS=16384;
type Task={question:Buffer;sent?:Buffer;done:boolean;retried?:boolean;resolve:(v:Uint8Array)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;signal?:AbortSignal;abort:()=>void;channel?:Channel};
type Channel={socket:TLSSocket;connected:boolean;closed:boolean;buffer:Buffer;task?:Task;idleTimer?:NodeJS.Timeout;born:number;messages:number;nextId:number;certUntil:number};
export type DotPoolOptions={maxConnections?:number;maxQueued?:number;idleMs?:number};
export function createVerifiedDotPool(upstream:VerifiedDotUpstream,options:DotPoolOptions={}){
  const maxConnections=options.maxConnections??8,maxQueued=options.maxQueued??64,idleMs=options.idleMs??7500;
  if(isIP(upstream.address)===0||!/^[a-z0-9](?:[a-z0-9.-]{1,251})[a-z0-9]$/i.test(upstream.servername)||upstream.servername.includes('..')||
    !Number.isSafeInteger(upstream.port)||upstream.port<1||upstream.port>65535||
    !Number.isSafeInteger(maxConnections)||maxConnections<1||maxConnections>16||
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
  function discard(c:Channel,error=Error('Verified DoT upstream disconnected'),retryable=false){
    if(c.closed)return;
    c.closed=true;channels.delete(c);if(c.idleTimer)clearTimeout(c.idleTimer);c.socket.destroy();
    const task=c.task;c.task=undefined;
    const emptyReply=c.buffer.length===0;
    c.buffer=Buffer.alloc(0);
    if(task){
      if(retryable&&!closed&&!task.done&&!task.retried&&!task.signal?.aborted&&c.messages>1&&emptyReply){
        task.retried=true;task.channel=undefined;task.sent=undefined;
        queue.unshift(task);
      }else{
        settle(task,error);
      }
    }
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
    socket.on('error',()=>discard(c,Error('Verified DoT TLS connection failed'),true));
    socket.on('close',()=>discard(c,undefined,true));
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

export interface CachedDnsResolverOptions{
  maxEntries?:number;
  minTtlMs?:number;
  maxTtlMs?:number;
  nodataTtlMs?:number;
  now?:()=>number;
}

function skipDnsName(packet:Buffer,start:number):number{
  let pos=start;
  for(let i=0;i<128;i++){
    if(pos>=packet.length)return -1;
    const len=packet[pos];
    if(len===0)return pos+1;
    if((len&0xc0)===0xc0)return pos+2<=packet.length?pos+2:-1;
    if((len&0xc0)!==0)return -1;
    pos+=1+len;
  }
  return -1;
}

function findUncompressedQnameEnd(wire:Uint8Array):number{
  let pos=12;
  for(let i=0;i<127;i++){
    if(pos>=wire.length)return -1;
    const len=wire[pos++];
    if(len===0)return pos;
    if(len>63||pos+len>wire.length)return -1;
    pos+=len;
  }
  return -1;
}

function computeCacheTtlMs(
  reply:Uint8Array,minTtlMs:number,maxTtlMs:number,nodataTtlMs:number,
):number|null{
  if(reply.length<12)return null;
  const packet=Buffer.from(reply.buffer,reply.byteOffset,reply.byteLength);
  const flags=packet.readUInt16BE(2);
  const rcode=flags&0x0f;
  const tc=(flags&0x0200)!==0;
  // Cache only complete NOERROR replies (never SERVFAIL, NXDOMAIN, REFUSED, or TC=1).
  if((flags&0x8000)===0||tc||rcode!==0)return null;
  const qdcount=packet.readUInt16BE(4);
  const ancount=packet.readUInt16BE(6);
  const nscount=packet.readUInt16BE(8);
  const arcount=packet.readUInt16BE(10);
  if(qdcount!==1)return null;
  let pos=skipDnsName(packet,12);
  if(pos<0||pos+4>packet.length)return null;
  pos+=4;
  const totalRrs=ancount+nscount+arcount;
  let minAnswerTtlSec=Number.POSITIVE_INFINITY;
  for(let i=0;i<totalRrs;i++){
    pos=skipDnsName(packet,pos);
    if(pos<0||pos+10>packet.length)return null;
    const rrType=packet.readUInt16BE(pos);
    const rrTtl=packet.readUInt32BE(pos+4);
    const rdLength=packet.readUInt16BE(pos+8);
    pos+=10+rdLength;
    if(pos>packet.length)return null;
    if(rrType===41){
      if(((rrTtl>>>24)&0xff)!==0)return null;
      continue;
    }
    if(i<ancount&&rrTtl<minAnswerTtlSec)minAnswerTtlSec=rrTtl;
  }
  if(pos!==packet.length)return null;
  if(ancount===0)return nodataTtlMs>0?nodataTtlMs:null;
  if(!Number.isFinite(minAnswerTtlSec))return null;
  return Math.min(maxTtlMs,Math.max(minTtlMs,minAnswerTtlSec*1000));
}

/** Bounded LRU + TTL cache wrapping an upstream DNS resolver so repeated queries do not pay TLS/WG RTT. */
export function createCachedDnsResolver(
  resolver:(wire:Uint8Array,signal?:AbortSignal)=>Promise<Uint8Array>,
  options:CachedDnsResolverOptions={},
){
  const maxEntries=options.maxEntries??1024;
  const minTtlMs=options.minTtlMs??5000;
  const maxTtlMs=Math.max(minTtlMs,options.maxTtlMs??60000);
  const nodataTtlMs=options.nodataTtlMs??15000;
  const now=options.now??Date.now;
  const cache=new Map<string,{wire:Buffer;expiresAt:number}>();
  return async(query:Uint8Array,signal?:AbortSignal):Promise<Uint8Array>=>{
    if(signal?.aborted||maxEntries<=0)return resolver(query,signal);
    let key:string;
    try{
      const q=parseDnsQuestion(query);
      const qView=Buffer.from(query.buffer,query.byteOffset,query.byteLength);
      const hasEdns=qView.readUInt16BE(10)>0?1:0;
      key=`${q.name}\0${q.type}\0${q.dnsClass}\0${hasEdns}`;
    }catch{
      return resolver(query,signal);
    }
    const currentTime=now();
    const hit=cache.get(key);
    if(hit!==undefined){
      if(hit.expiresAt>currentTime){
        cache.delete(key);
        cache.set(key,hit);
        const out=Buffer.from(hit.wire);
        const qView=Buffer.from(query.buffer,query.byteOffset,query.byteLength);
        qView.copy(out,0,0,2);
        out[2]=(out[2]&0xfe)|(qView[2]&0x01);
        const qEnd=findUncompressedQnameEnd(qView);
        const rEnd=findUncompressedQnameEnd(out);
        if(qEnd>12&&qEnd===rEnd)qView.copy(out,12,12,qEnd);
        if(dnsResponseMatchesQuestion(query,out))return out;
      }
      cache.delete(key);
    }
    const reply=await resolver(query,signal);
    if(!dnsResponseMatchesQuestion(query,reply))return reply;
    const ttlMs=computeCacheTtlMs(reply,minTtlMs,maxTtlMs,nodataTtlMs);
    if(ttlMs!==null&&ttlMs>0){
      cache.delete(key);
      while(cache.size>=maxEntries){
        const oldestKey=cache.keys().next().value;
        if(oldestKey===undefined)break;
        cache.delete(oldestKey);
      }
      cache.set(key,{wire:Buffer.from(reply),expiresAt:now()+ttlMs});
    }
    return reply;
  };
}
