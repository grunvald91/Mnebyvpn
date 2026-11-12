/** Dedicated opt-in DoT access frontend. No public listener until real
 * wildcard TLS, DNS SNI dispatch, commercial gates and phone E2E.
 * This authenticates DNS messages, NOT the independent TCP/SNI proxy.
 */
import {X509Certificate} from 'node:crypto';
import {createServer as createTlsServer,type Server as TlsServer,type TLSSocket} from 'node:tls';
import {connect as connectTcp,type Socket} from 'node:net';
import type {Pool} from 'pg';
import {authorizePersonalDnsQuery,dnsTokenFromSni,dnsHostname} from './personal.ts';

const MAX_WIRE=16384;
const MAX_OUTSTANDING=32;
const MAX_BUFFER=(MAX_WIRE+2)*MAX_OUTSTANDING;
const DNS_REPLY_TIMEOUT_MS=10000;
const SAMPLE_HOSTNAME=dnsHostname('u'+'a'.repeat(48));

export interface PersonalDotGatewayOptions {
  key:Buffer|string;
  cert:Buffer|string;
  db:Pick<Pool,'query'>;
  upstreamHost:'127.0.0.1'|'::1';
  upstreamPort:number;
  queryDeadlineMs?:number;
}
interface DnsFrame {id:number;frame:Buffer;}

function validQuestion(packet:Buffer):boolean{
  if(packet.length<17||packet.length>MAX_WIRE)return false;
  const flags=packet.readUInt16BE(2);
  // Not a response, not a zone-transfer/update opcode, no truncated query.
  return (flags&0xFA00)===0 &&
    packet.readUInt16BE(4)===1 &&
    packet.readUInt16BE(6)===0 &&
    packet.readUInt16BE(8)===0;
}
function validAnswer(packet:Buffer):boolean{
  if(packet.length<12||packet.length>MAX_WIRE)return false;
  const flags=packet.readUInt16BE(2);
  // This is one DNS response, not a query or another opcode.
  return (flags&0xF800)===0x8000;
}

export function createPersonalDotGateway(o:PersonalDotGatewayOptions):TlsServer{
  if(!Number.isSafeInteger(o.upstreamPort)||o.upstreamPort<1||
      o.upstreamPort>65535)throw Error('Invalid CoreDNS TCP port');
  const deadline=o.queryDeadlineMs??1500;
  if(!Number.isSafeInteger(deadline)||deadline<50||deadline>5000)
    throw Error('Invalid DNS authorization deadline');
  // Misconfigured certificates must stop startup before any client is told
  // the random per-customer hostname is a valid Android Private DNS address.
  const certificate=new X509Certificate(o.cert);
  if(!certificate.checkHost(SAMPLE_HOSTNAME))
    throw Error('Personal DNS TLS certificate does not cover customer hostnames');

  const server=createTlsServer({
    key:o.key,cert:o.cert,minVersion:'TLSv1.2',
    handshakeTimeout:10000,requestCert:false,
  },(client:TLSSocket)=>{
    const token=dnsTokenFromSni(client.servername||'');
    if(!token){client.destroy();return;}
    const verifiedToken:string=token;
    let received=Buffer.alloc(0),responses=Buffer.alloc(0);
    const queue:DnsFrame[]=[];
    const reservedIds=new Set<number>();
    const pending=new Map<number,NodeJS.Timeout>();
    let upstream:Socket|null=null;
    let busy=false,done=false;

    const stop=()=>{
      if(done)return;
      done=true;
      for(const timeout of pending.values())clearTimeout(timeout);
      pending.clear();
      reservedIds.clear();
      queue.length=0;
      received=Buffer.alloc(0);
      responses=Buffer.alloc(0);
      client.destroy();
      upstream?.destroy();
    };
    client.on('error',stop);
    client.on('close',stop);
    client.setTimeout(120000,stop);

    const onResponseData=(chunk:Buffer)=>{
      if(done)return;
      if(responses.length+chunk.length>MAX_BUFFER){stop();return;}
      responses=Buffer.concat([responses,chunk]);
      while(!done&&responses.length>=2){
        const size=responses.readUInt16BE(0);
        if(size<12||size>MAX_WIRE){stop();return;}
        if(responses.length<size+2)break;
        const payload=responses.subarray(2,2+size);
        if(!validAnswer(payload)){stop();return;}
        const id=payload.readUInt16BE(0);
        const timer=pending.get(id);
        if(!timer){stop();return;} // unsolicited or replayed upstream answer
        clearTimeout(timer);
        pending.delete(id);
        reservedIds.delete(id);
        const frame=Buffer.from(responses.subarray(0,size+2));
        responses=responses.subarray(size+2);
        if(!client.write(frame))upstream?.pause();
      }
    };

    async function upstreamReady():Promise<Socket>{
      if(upstream&&!upstream.destroyed)return upstream;
      const s=connectTcp({host:o.upstreamHost,port:o.upstreamPort,allowHalfOpen:true});
      upstream=s;
      s.setTimeout(15000,stop);
      s.on('error',stop);
      s.on('close',()=>{if(!done)stop();});
      s.on('data',onResponseData);
      client.on('drain',()=>s.resume());
      await new Promise<void>((resolve,reject)=>{
        let settled=false;
        const finish=(error?:Error)=>{
          if(settled)return;
          settled=true;
          clearTimeout(timer);
          s.off('connect',onConnect);
          s.off('error',onError);
          if(error)reject(error);else resolve();
        };
        const onConnect=()=>finish();
        const onError=(error:Error)=>finish(error);
        const timer=setTimeout(()=>finish(Error('CoreDNS connect timeout')),deadline);
        s.once('connect',onConnect);
        s.once('error',onError);
      });
      if(done)throw Error('DNS client disconnected');
      return s;
    }

    async function waitDrain(s:Socket):Promise<void>{
      if(s.destroyed)throw Error('CoreDNS closed');
      client.pause();
      try{
        await new Promise<void>((resolve,reject)=>{
          let settled=false;
          const finish=(error?:Error)=>{
            if(settled)return;
            settled=true;
            clearTimeout(timer);
            s.off('drain',drain);
            s.off('close',closed);
            if(error)reject(error);else resolve();
          };
          const drain=()=>finish();
          const closed=()=>finish(Error('CoreDNS closed'));
          const timer=setTimeout(()=>finish(Error('CoreDNS stalled')),deadline);
          s.once('drain',drain);
          s.once('close',closed);
        });
      }finally{
        if(!done)client.resume();
      }
    }

    async function flush(){
      if(busy||done)return;
      busy=true;
      try{
        while(queue.length&&!done){
          const next=queue.shift()!;
          // Query accounting is explicitly "authorized attempts", not
          // confirmed responses or bytes delivered to a device.
          const authorized=await authorizePersonalDnsQuery(o.db,verifiedToken,deadline);
          if(!authorized||done){stop();return;}
          const s=await upstreamReady();
          if(done)return;
          // Register exactly one pending response before forwarding. The
          // timeout prevents permanently occupying subscription sockets.
          const timer=setTimeout(stop,DNS_REPLY_TIMEOUT_MS);
          pending.set(next.id,timer);
          if(!s.write(next.frame))await waitDrain(s);
        }
      }catch{stop();}
      finally{busy=false;}
    }

    client.on('data',(chunk:Buffer)=>{
      if(done)return;
      if(received.length+chunk.length>MAX_BUFFER){stop();return;}
      received=Buffer.concat([received,chunk]);
      while(!done&&received.length>=2){
        const size=received.readUInt16BE(0);
        if(size<17||size>MAX_WIRE){stop();return;}
        if(received.length<size+2)break;
        const packet=received.subarray(2,size+2);
        if(!validQuestion(packet)){stop();return;}
        const id=packet.readUInt16BE(0);
        // Limit both queued requests AND unanswered DNS messages, not just
        // the queue. Otherwise a paid connection could send unbounded work.
        if(reservedIds.size>=MAX_OUTSTANDING||reservedIds.has(id)){
          stop();return;
        }
        reservedIds.add(id);
        queue.push({id,frame:Buffer.from(received.subarray(0,size+2))});
        received=received.subarray(size+2);
      }
      void flush();
    });
  });
  server.maxConnections=1024;
  return server;
}
