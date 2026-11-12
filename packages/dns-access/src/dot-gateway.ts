/** Dedicated opt-in DoT customer-access front end. NEVER bind public :853
 * until wildcard TLS, DNS wildcard A records, per-query revocation and
 * mobile client acceptance are verified. Existing CoreDNS stays unchanged.
 */
import {createServer as createTlsServer,type Server as TlsServer,type TLSSocket} from 'node:tls';
import {connect as connectTcp,type Socket} from 'node:net';
import type {Pool} from 'pg';
import {authorizePersonalDnsQuery,dnsTokenFromSni} from './personal.ts';

const MAX_WIRE=16384;
const MAX_PENDING=8;
const MAX_BUFFER=(MAX_WIRE+2)*MAX_PENDING;

export interface PersonalDotGatewayOptions {
  key:Buffer|string;
  cert:Buffer|string;
  db:Pick<Pool,'query'>;
  upstreamHost:'127.0.0.1'|'::1';
  upstreamPort:number;
  queryDeadlineMs?:number;
}

function standardDnsQuestion(packet:Buffer):boolean{
  if(packet.length<17||packet.length>MAX_WIRE)return false;
  // One conventional DNS question (with optional EDNS). Never forward a
  // framed response, update or arbitrary TCP payload as a DNS query.
  const flags=packet.readUInt16BE(2);
  return (flags&0xF800)===0 && packet.readUInt16BE(4)===1 &&
    packet.readUInt16BE(6)===0 && packet.readUInt16BE(8)===0;
}

export function createPersonalDotGateway(o:PersonalDotGatewayOptions):TlsServer{
  if(!Number.isSafeInteger(o.upstreamPort)||o.upstreamPort<1||
      o.upstreamPort>65535)throw Error('Invalid CoreDNS TCP port');
  const deadline=o.queryDeadlineMs??1500;
  if(!Number.isSafeInteger(deadline)||deadline<50||deadline>5000)
    throw Error('Invalid DNS authorization deadline');

  const server=createTlsServer({
    key:o.key,cert:o.cert,minVersion:'TLSv1.2',requestCert:false,
    // Not enabling TLS 1.3 0-RTT: replay could count query attempts twice.
  },(client:TLSSocket)=>{
    const label=dnsTokenFromSni(client.servername||'');
    if(!label){client.destroy();return;}
    const verifiedToken:string=label;
    let received=Buffer.alloc(0),queue:Buffer[]=[];
    let upstream:Socket|null=null;
    let busy=false,done=false;
    const stop=()=>{
      if(done)return;
      done=true;
      queue=[];
      received=Buffer.alloc(0);
      client.destroy();
      upstream?.destroy();
    };

    async function upstreamReady():Promise<Socket>{
      if(upstream&&!upstream.destroyed)return upstream;
      const s=connectTcp({host:o.upstreamHost,port:o.upstreamPort,allowHalfOpen:true});
      s.setTimeout(30000,stop);
      s.on('error',stop);
      s.on('close',()=>{if(!done)stop();});
      s.on('data',(chunk:Buffer)=>{
        if(done||client.destroyed)return;
        if(!client.write(chunk))s.pause();
      });
      client.on('drain',()=>s.resume());
      upstream=s;
      // An independent deadline limits hung local DNS; cannot connect to
      // user-selected hosts because only loopback is accepted in opts.
      await new Promise<void>((resolve,reject)=>{
        let settled=false;
        const finish=(err?:Error)=>{
          if(settled)return;
          settled=true;
          clearTimeout(timer);
          s.off('connect',onConnect);
          s.off('error',onError);
          if(err)reject(err);else resolve();
        };
        const onConnect=()=>finish();
        const onError=(err:Error)=>finish(err);
        const timer=setTimeout(()=>finish(Error('CoreDNS connect timeout')),deadline);
        s.once('connect',onConnect);
        s.once('error',onError);
      });
      return s;
    }

    async function flush(){
      if(busy||done)return;
      busy=true;
      try{
        while(queue.length&&!done){
          const wire=queue.shift()!;
          // Expiry/refund/manual revoke checked for EACH DNS message, not
          // only at the first TLS connection.
          const permitted=await authorizePersonalDnsQuery(o.db,verifiedToken,deadline);
          if(!permitted||done){stop();return;}
          const upstream=await upstreamReady();
          if(done)return;
          if(!upstream.write(wire)){
            client.pause();
            await new Promise<void>((resolve,reject)=>{
              const timer=setTimeout(()=>reject(Error('CoreDNS stalled')),deadline);
              upstream.once('drain',()=>{clearTimeout(timer);resolve();});
              upstream.once('close',()=>{clearTimeout(timer);reject(Error('CoreDNS closed'));});
            });
            if(!done)client.resume();
          }
        }
      }catch{stop();}
      finally{busy=false;}
    }

    client.on('data',(chunk:Buffer)=>{
      if(done)return;
      if(received.length+chunk.length>MAX_BUFFER){stop();return;}
      received=Buffer.concat([received,chunk]);
      while(!done&&received.length>=2){
        const n=received.readUInt16BE(0);
        if(n<17||n>MAX_WIRE){stop();return;}
        if(received.length<n+2)break;
        const packet=received.subarray(2,n+2);
        if(!standardDnsQuestion(packet)){stop();return;}
        if(queue.length>=MAX_PENDING){stop();return;}
        queue.push(Buffer.from(received.subarray(0,n+2)));
        received=received.subarray(n+2);
      }
      void flush();
    });
    client.on('error',stop);
    client.on('close',stop);
    client.setTimeout(120000,stop);
  });
  server.maxConnections=1024;
  return server;
}
