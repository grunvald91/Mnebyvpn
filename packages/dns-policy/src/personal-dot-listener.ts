/** Private, opt-in DNS-over-TLS canary. This module NEVER listens on its own.
 * The caller MUST bind only 127.0.0.1:8853 and perform explicit release gates.
 * TLS SNI carries a transferable bearer identity; it is not device binding.
 */
import {X509Certificate,createHash} from 'node:crypto';
import {connect as connectTcp} from 'node:net';
import {createServer as createTlsServer,type Server as TlsServer} from 'node:tls';
import type {Writable} from 'node:stream';
import type {Pool} from 'pg';
import {
  resolvePersonalDnsWithSettlement,dnsResponseMatchesQuestion,
  type Classifier,type DnsResolver,
} from './personal-dot-gateway-core.ts';
import {parsePersonalDoTHostname} from './personal-dot-identity.ts';

const MAX_DNS=16384;
const MAX_QUEUE=16;
const MAX_BUFFER=(MAX_DNS+2)*MAX_QUEUE;
const TEST_HOST_A='aaaaaaaaaaaa.dns.mnebyvpn.site';
const TEST_HOST_B='bbbbbbbbbbbb.dns.mnebyvpn.site';
const MAX_AUTH_CACHE=4096;
const AUTH_RECHECK_MS=60000;
const AUTH_OUTAGE_GRACE_MS=90000;
const LABEL_RATE_PER_SEC=30;
const LABEL_BURST=60;
const MAX_TLS_BUFFERED=MAX_BUFFER;
const TLS_DRAIN_TIMEOUT_MS=3000;

/** A false write() return means backpressure, not a failed write.
 * The frame has already been queued by Node. Resume once 'drain' fires.
 * Keep time and buffered-byte bounds so stalled clients cannot consume
 * unbounded memory. The caller owns closing the socket on failure.
 */
export function writeDnsFrameWithBackpressure(
  writable:Pick<Writable,'write'|'writableLength'|'writable'|'destroyed'|'once'|'off'>,
  frame:Buffer,
  timeoutMs=TLS_DRAIN_TIMEOUT_MS,
):Promise<boolean>{
  if(!writable.writable||writable.destroyed||
     frame.length<2||frame.length>MAX_DNS+2||
     writable.writableLength+frame.length>MAX_TLS_BUFFERED)
    return Promise.resolve(false);
  let written:boolean;
  try{written=writable.write(frame);}catch{return Promise.resolve(false);}
  if(written)return Promise.resolve(true);
  return new Promise(resolve=>{
    let finished=false;
    const finish=(ok:boolean)=>{
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      writable.off('drain',onDrain);
      writable.off('close',onClosed);
      writable.off('error',onClosed);
      resolve(ok&&!writable.destroyed&&writable.writable);
    };
    const onDrain=()=>finish(true);
    const onClosed=()=>finish(false);
    const timer=setTimeout(()=>finish(false),timeoutMs);
    writable.once('drain',onDrain);
    writable.once('close',onClosed);
    writable.once('error',onClosed);
    if(writable.destroyed||!writable.writable)finish(false);
  });
}

type Upstream={host:'127.0.0.1'|'::1';port:number};
function validPort(value:number):boolean{
  return Number.isSafeInteger(value)&&value>=1&&value<=65535;
}

/** One DNS/TCP question per local upstream socket; bound response size, ID,
 * and lifetime. No foreign DNS server, shared proxy or public port contacted.
 */
export function queryLoopbackDnsTcp(
  server:Upstream,query:Uint8Array,deadlineMs=2000,signal?:AbortSignal,
):Promise<Uint8Array>{
  if(!validPort(server.port)||!(server.host==='127.0.0.1'||server.host==='::1')||
     query.length<12||query.length>MAX_DNS)
    return Promise.reject(Error('Invalid local DNS upstream'));
  if(signal?.aborted)return Promise.reject(Error('DNS query aborted'));
  return new Promise<Uint8Array>((resolve,reject)=>{
    let finished=false,received=Buffer.alloc(0);
    const socket=connectTcp({host:server.host,port:server.port});
    const finish=(err?:Error,response?:Buffer)=>{
      if(finished)return;
      finished=true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort',abort);
      socket.destroy();
      if(err)reject(err);else if(response)resolve(response);else reject(Error('No DNS response'));
    };
    const deadline=setTimeout(()=>finish(Error('DNS upstream timeout')),deadlineMs);
    const abort=()=>finish(Error('DNS query aborted'));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    socket.on('error',()=>finish(Error('DNS upstream failed')));
    socket.on('close',()=>{if(!finished)finish(Error('DNS upstream closed'));});
    socket.on('connect',()=>{
      const frame=Buffer.alloc(query.length+2);
      frame.writeUInt16BE(query.length,0);
      frame.set(query,2);
      socket.write(frame);
    });
    socket.on('data',(chunk:Buffer)=>{
      if(finished)return;
      if(received.length+chunk.length>MAX_DNS+2){finish(Error('Oversized DNS answer'));return;}
      received=Buffer.concat([received,chunk]);
      if(received.length<2)return;
      const size=received.readUInt16BE(0);
      if(size<12||size>MAX_DNS){finish(Error('Invalid DNS answer length'));return;}
      if(received.length<size+2)return;
      const answer=received.subarray(2,size+2);
      const original=Buffer.from(query.buffer,query.byteOffset,query.byteLength);
      if(received.length!==size+2||!dnsResponseMatchesQuestion(original,answer)){ 
        finish(Error('Unmatched or invalid DNS answer'));return;
      }
      finish(undefined,Buffer.from(answer));
    });
  });
}

export interface PersonalDotListenerOptions {
  key:string|Buffer;
  cert:string|Buffer;
  db:Pick<Pool,'query'>;
  classify:Classifier;
  mapped:DnsResolver;
  direct:DnsResolver;
  queryTimeoutMs?:number;
  /** Optional in-memory limits; never a substitute for a trusted ingress ACL. */
  now?:()=>number;
}

export function createPersonalDotListener(o:PersonalDotListenerOptions):TlsServer{
  const timeout=o.queryTimeoutMs??2500;
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>10000)
    throw Error('Invalid query deadline');
  const cert=new X509Certificate(o.cert);
  // Checking two hard-coded sample SNI names is insufficient: a certificate
  // listing only those exact SANs would pass but fail for real subscriber keys.
  const hasWildcard=cert.subjectAltName?.split(', ').some(
    san=>san.trim()==='DNS:*.dns.mnebyvpn.site');
  if(!hasWildcard||!cert.checkHost(TEST_HOST_A)||!cert.checkHost(TEST_HOST_B))
    throw Error('TLS certificate must contain the personal DNS wildcard SAN');
  const now=o.now??Date.now;
  // Positive-only 60s identity cache: avoid a DB existence check on every DNS
  // message while retaining all per-premium-query reserve/settle operations.
  // Recheck upon the next request after 60s; never extend validity on a hit.
  // During a DB outage, a verified identity may use DIRECT-only for 90s from
  // the last successful lookup; cached identity NEVER authorizes premium use.
  // Revocation of direct-only use takes effect no later than next recheck.
  // Cache stores only SHA-256 key digests, never plaintext bearer names.
  const authCache=new Map<string,number>();
  const labelRates=new Map<string,{tokens:number,last:number}>();
  // TLS clients forwarded by Nginx stream often all have loopback source IP.
  // Limit *per credential*, not by that shared proxy socket source.
  const credentialConnections=new Map<string,number>();
  const trim=<T>(map:Map<string,T>)=>{
    while(map.size>MAX_AUTH_CACHE){const old=map.keys().next().value;
      if(old===undefined)break;map.delete(old);}
  };
  const server=createTlsServer({
    key:o.key,cert:o.cert,minVersion:'TLSv1.2',handshakeTimeout:8000,
    requestCert:false,
  },socket=>{
    const name=socket.servername||'';
    const label=parsePersonalDoTHostname(name);
    if(!label){socket.destroy();return;}
    const digest=createHash('sha256').update(label).digest('hex');
    const connected=credentialConnections.get(digest)??0;
    if(connected>=8){socket.destroy();return;}
    credentialConnections.set(digest,connected+1);
    const activeSignals=new Set<AbortController>();
    let buffer=Buffer.alloc(0),busy=false,closed=false;
    const pending:Buffer[]=[];
    const stop=()=>{
      if(closed)return;
      closed=true;pending.length=0;buffer=Buffer.alloc(0);
      for(const controller of activeSignals)controller.abort();
      activeSignals.clear();
      const count=credentialConnections.get(digest)??1;
      if(count<=1)credentialConnections.delete(digest);
      else credentialConnections.set(digest,count-1);
      socket.destroy();
    };
    socket.setTimeout(30000,stop);
    socket.on('error',stop);
    socket.on('close',stop);
    async function flush():Promise<void>{
      if(busy||closed)return;
      busy=true;
      try{
        while(!closed&&pending.length){
          const request=pending.shift()!;
          // Per-secret token bucket limits abuse even behind a shared
          // loopback reverse proxy (where source IP is not the handset IP).
          const current=now();
          const prev=labelRates.get(digest);
          const available=Math.min(LABEL_BURST,
            (prev?.tokens??LABEL_BURST)+
              Math.max(0,current-(prev?.last??current))*LABEL_RATE_PER_SEC/1000);
          if(available<1){stop();return;}
          labelRates.delete(digest);
          labelRates.set(digest,{tokens:available-1,last:current});
          trim(labelRates);
          let offlineDirectOnly=false;
          const verifiedAt=authCache.get(digest);
          // Auth-cache hits skip only the credential existence check. Premium
          // DNS messages still reserve and settle quota individually below.
          if(verifiedAt!==undefined&&current>=verifiedAt&&
             current-verifiedAt<AUTH_RECHECK_MS){
            authCache.delete(digest);
            authCache.set(digest,verifiedAt); // LRU touch, not sliding TTL
          }else{
            try{
              // All connections, including direct routes, must initially be
              // recognized. Failed/revoked identities are NEVER cached.
              const {rows}=await o.db.query(
                'SELECT recognize_personal_dns_credential($1) AS known',[label]);
              if(rows.length!==1||rows[0].known!==true){
                authCache.delete(digest);stop();return;
              }
              authCache.delete(digest);
              authCache.set(digest,current);
              trim(authCache);
            }catch{
              // Old positive status permits DIRECT-only DNS temporarily,
              // never paid/mapped answers during an authorization DB outage.
              if(verifiedAt===undefined||current<verifiedAt||
                 current-verifiedAt>=AUTH_OUTAGE_GRACE_MS){
                authCache.delete(digest);stop();return;
              }
              offlineDirectOnly=true;
            }
          }
          let deadline:NodeJS.Timeout|undefined;
          const controller=new AbortController();
          activeSignals.add(controller);
          let answer:Uint8Array;
          try{
            const work=offlineDirectOnly?o.direct(request,controller.signal):
              resolvePersonalDnsWithSettlement(name,request,o.classify,
                async(token,id)=>{
                  const r=await o.db.query(
                    'SELECT reserve_personal_dns_query($1,$2::uuid) AS verdict',
                    [token,id]);
                  return String(r.rows[0]?.verdict??'DENY_UNKNOWN');
                },
                async(id,success)=>{
                  const r=await o.db.query(
                    'SELECT finish_personal_dns_query($1::uuid,$2) AS verdict',
                    [id,success]);
                  return String(r.rows[0]?.verdict??'DENY_UNKNOWN');
                },o.mapped,o.direct,controller.signal);
            answer=await Promise.race([
              work,
              new Promise<never>((_,reject)=>{
                deadline=setTimeout(()=>{
                  controller.abort();
                  reject(Error('DNS query deadline exceeded'));
                },timeout);
              }),
            ]);
          }finally{
            if(deadline)clearTimeout(deadline);
            activeSignals.delete(controller);
          }
          if(closed)return;
          if(answer.byteLength<12||answer.byteLength>MAX_DNS){stop();return;}
          const output=Buffer.from(answer);
          if(!dnsResponseMatchesQuestion(request,output)){
            stop();return;
          }
          const framed=Buffer.alloc(output.length+2);
          framed.writeUInt16BE(output.length,0);
          output.copy(framed,2);
          // A false write() result is backpressure, not delivery failure.
          // Bound buffer size and wait for drain; a genuinely stalled client
          // is still disconnected after a short deadline.
          if(!await writeDnsFrameWithBackpressure(socket,framed)){stop();return;}
        }
      }catch{stop();}
      finally{busy=false;}
    }
    socket.on('data',(chunk:Buffer)=>{
      if(closed)return;
      if(buffer.length+chunk.length>MAX_BUFFER){stop();return;}
      buffer=Buffer.concat([buffer,chunk]);
      while(!closed&&buffer.length>=2){
        const n=buffer.readUInt16BE(0);
        if(n<17||n>MAX_DNS){stop();return;}
        if(buffer.length<n+2)break;
        if(pending.length>=MAX_QUEUE){stop();return;}
        pending.push(Buffer.from(buffer.subarray(2,n+2)));
        buffer=buffer.subarray(n+2);
      }
      void flush();
    });
  });
  server.maxConnections=128;
  return server;
}
