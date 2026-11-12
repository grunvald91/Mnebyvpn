/** Private, opt-in DNS-over-TLS canary. This module NEVER listens on its own.
 * The caller MUST bind only 127.0.0.1:8853 and perform explicit release gates.
 * TLS SNI carries a transferable bearer identity; it is not device binding.
 */
import {X509Certificate} from 'node:crypto';
import {connect as connectTcp} from 'node:net';
import {createServer as createTlsServer,type Server as TlsServer} from 'node:tls';
import type {Pool} from 'pg';
import {
  resolvePersonalDnsMessage,type Classifier,type DnsResolver,
} from './personal-dot-gateway-core.ts';
import {parsePersonalDoTHostname} from './personal-dot-identity.ts';

const MAX_DNS=16384;
const MAX_QUEUE=16;
const MAX_BUFFER=(MAX_DNS+2)*MAX_QUEUE;
const TEST_HOST_A='aaaaaaaaaaaa.dns.mnebyvpn.site';
const TEST_HOST_B='bbbbbbbbbbbb.dns.mnebyvpn.site';

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
      if(received.length!==size+2||answer.readUInt16BE(0)!==original.readUInt16BE(0)||
         (answer.readUInt16BE(2)&0x8000)===0){
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
}

export function createPersonalDotListener(o:PersonalDotListenerOptions):TlsServer{
  const timeout=o.queryTimeoutMs??2500;
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>10000)
    throw Error('Invalid query deadline');
  const cert=new X509Certificate(o.cert);
  if(!cert.checkHost(TEST_HOST_A)||!cert.checkHost(TEST_HOST_B))
    throw Error('TLS certificate must cover personal DNS wildcard');
  const server=createTlsServer({
    key:o.key,cert:o.cert,minVersion:'TLSv1.2',handshakeTimeout:8000,
    requestCert:false,
  },socket=>{
    const name=socket.servername||'';
    const label=parsePersonalDoTHostname(name);
    if(!label){socket.destroy();return;}
    let buffer=Buffer.alloc(0),busy=false,closed=false;
    const pending:Buffer[]=[];
    const stop=()=>{if(closed)return;closed=true;pending.length=0;
      buffer=Buffer.alloc(0);socket.destroy();};
    socket.setTimeout(30000,stop);
    socket.on('error',stop);
    socket.on('close',stop);
    async function flush():Promise<void>{
      if(busy||closed)return;
      busy=true;
      try{
        while(!closed&&pending.length){
          const request=pending.shift()!;
          // Unlike premium-only accounting, even direct DNS requires a
          // known, unrevoked credential. Otherwise this is an open resolver.
          const {rows}=await o.db.query(
            'SELECT recognize_personal_dns_credential($1) AS known',[label]);
          if(rows.length!==1||rows[0].known!==true){stop();return;}
          const answer=await Promise.race([
            resolvePersonalDnsMessage(name,request,o.classify,
              async token=>{
                const r=await o.db.query(
                  'SELECT consume_personal_dns_query($1) AS verdict',[token]);
                return String(r.rows[0]?.verdict??'DENY_UNKNOWN');
              },o.mapped,o.direct),
            new Promise<never>((_,reject)=>setTimeout(
              ()=>reject(Error('DNS query deadline exceeded')),timeout)),
          ]);
          if(closed)return;
          if(answer.byteLength<12||answer.byteLength>MAX_DNS){stop();return;}
          const output=Buffer.from(answer);
          if((output.readUInt16BE(2)&0x8000)===0||
             output.readUInt16BE(0)!==request.readUInt16BE(0)){
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
  server.maxConnections=256;
  return server;
}
