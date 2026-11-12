/** Private, opt-in DNS-over-TLS canary. This module NEVER listens on its own.
 * The caller MUST bind only 127.0.0.1:8853 and perform explicit release gates.
 * TLS SNI carries a transferable bearer identity; it is not device binding.
 */
import {X509Certificate,createHash} from 'node:crypto';
import {connect as connectTcp} from 'node:net';
import {createServer as createTlsServer,type Server as TlsServer} from 'node:tls';
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
const AUTH_OUTAGE_GRACE_MS=90000;
const LABEL_RATE_PER_SEC=30;
const LABEL_BURST=60;

type Upstream={host:'127.0.0.1'|'::1';port:number};
function validPort(value:number):boolean{
  return Number.isSafeInteger(value)&&value>=1&&value<=65535;
}

/** One DNS/TCP question per local upstream socket; bound response size, ID,
 * and lifetime. No foreign DNS server, shared proxy or public port contacted.
 */
export function queryLoopbackDnsTcp(
  server:Upstream,query:Uint8Array,deadlineMs=2000,
):Promise<Uint8Array>{
  if(!validPort(server.port)||!(server.host==='127.0.0.1'||server.host==='::1')||
     query.length<12||query.length>MAX_DNS)
    return Promise.reject(Error('Invalid local DNS upstream'));
  return new Promise<Uint8Array>((resolve,reject)=>{
    let finished=false,received=Buffer.alloc(0);
    const socket=connectTcp({host:server.host,port:server.port});
    const finish=(err?:Error,response?:Buffer)=>{
      if(finished)return;
      finished=true;
      clearTimeout(deadline);
      socket.destroy();
      if(err)reject(err);else if(response)resolve(response);else reject(Error('No DNS response'));
    };
    const deadline=setTimeout(()=>finish(Error('DNS upstream timeout')),deadlineMs);
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
  // A bounded, positive-only identity cache permits DIRECT DNS for a recently
  // verified bearer during a short DB outage. Never grants premium routing.
  // Keep only SHA-256 key digests; no bearer hostname in cache or logs.
  const authCache=new Map<string,number>();
  const labelRates=new Map<string,{tokens:number,last:number}>();
  const sourceConnections=new Map<string,number>();
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
    const source=socket.remoteAddress??'unknown';
    const connected=sourceConnections.get(source)??0;
    if(connected>=12){socket.destroy();return;}
    sourceConnections.set(source,connected+1);
    const activeSignals=new Set<AbortController>();
    let buffer=Buffer.alloc(0),busy=false,closed=false;
    const pending:Buffer[]=[];
    const stop=()=>{
      if(closed)return;
      closed=true;pending.length=0;buffer=Buffer.alloc(0);
      for(const controller of activeSignals)controller.abort();
      activeSignals.clear();
      const count=sourceConnections.get(source)??1;
      if(count<=1)sourceConnections.delete(source);
      else sourceConnections.set(source,count-1);
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
          try{
            // All connections, including direct routes, require an existing
            // non-revoked credential; otherwise this is an open DNS resolver.
            const {rows}=await o.db.query(
              'SELECT recognize_personal_dns_credential($1) AS known',[label]);
            if(rows.length!==1||rows[0].known!==true){
              authCache.delete(digest);stop();return;
            }
            authCache.delete(digest);
            authCache.set(digest,current+AUTH_OUTAGE_GRACE_MS);
            trim(authCache);
          }catch{
            const goodUntil=authCache.get(digest)??0;
            if(current>=goodUntil){authCache.delete(digest);stop();return;}
            offlineDirectOnly=true;
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
          // Bound the session: kill a slow client rather than buffering
          // unbounded queued replies in Node's TLS writable stream.
          if(!socket.write(framed)){stop();return;}
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
