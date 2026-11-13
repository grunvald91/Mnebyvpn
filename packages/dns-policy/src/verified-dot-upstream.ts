/** Bounded DNS-over-TLS upstream resolver.
 * This is only an *outbound* transport. It never binds ingress sockets,
 * modifies CoreDNS, or grants a customer access to a mapped answer.
 */
import {connect as connectTls} from 'node:tls';
import {isIP} from 'node:net';
import {dnsResponseMatchesQuestion,parseDnsQuestion} from './personal-dot-gateway-core.ts';

const MAX_DNS=16384;
export interface VerifiedDotUpstream {
  address:string;
  servername:string;
  port:number;
  /** Test CA only; default is system trust store. Never disable validation. */
  ca?:Buffer|string;
}

/** DNS/TCP framing per RFC 7858; TLS peer hostname and trust MUST validate. */
export function queryVerifiedDotTls(
  upstream:VerifiedDotUpstream,wire:Uint8Array,timeoutMs=3500,
  signal?:AbortSignal,
):Promise<Uint8Array>{
  if(isIP(upstream.address)===0 ||
     !/^[a-z0-9](?:[a-z0-9.-]{1,251})[a-z0-9]$/i.test(upstream.servername) ||
     upstream.servername.includes('..') ||
     !Number.isSafeInteger(upstream.port)||upstream.port<1||upstream.port>65535 ||
     !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000 ||
     !(wire instanceof Uint8Array)||wire.length>MAX_DNS ||
     signal?.aborted){
    return Promise.reject(Error('Invalid or cancelled verified DoT upstream request'));
  }
  try{parseDnsQuestion(wire);}catch{
    return Promise.reject(Error('Invalid DNS query for verified DoT upstream'));
  }
  const question=Buffer.from(wire);
  return new Promise<Uint8Array>((resolve,reject)=>{
    let done=false,received=Buffer.alloc(0);
    const tls=connectTls({
      host:upstream.address,port:upstream.port,
      servername:upstream.servername,rejectUnauthorized:true,
      minVersion:'TLSv1.2',...(upstream.ca?{ca:upstream.ca}:{}),
    });
    const stop=(error?:Error,answer?:Buffer)=>{
      if(done)return;
      done=true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort',abort);
      tls.destroy();
      if(error)reject(error);
      else if(answer)resolve(answer);
      else reject(Error('Verified DoT upstream ended without a reply'));
    };
    const abort=()=>stop(Error('Verified DoT upstream request aborted'));
    const deadline=setTimeout(()=>stop(Error('Verified DoT upstream timeout')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    tls.on('secureConnect',()=>{
      if(done)return;
      if(!tls.authorized){
        stop(Error('Unverified TLS upstream certificate'));return;
      }
      const framed=Buffer.alloc(question.length+2);
      framed.writeUInt16BE(question.length,0);question.copy(framed,2);
      tls.write(framed);
    });
    tls.on('error',()=>stop(Error('Verified DoT TLS connection or certificate rejected')));
    tls.on('close',()=>stop(Error('Verified DoT TLS socket closed')));
    tls.on('data',(chunk:Buffer)=>{
      if(done)return;
      if(received.length+chunk.length>MAX_DNS+2){
        stop(Error('Oversized verified DoT response'));return;
      }
      received=Buffer.concat([received,chunk]);
      if(received.length<2)return;
      const length=received.readUInt16BE(0);
      if(length<17||length>MAX_DNS){
        stop(Error('Malformed verified DoT response length'));return;
      }
      if(received.length<length+2)return;
      const answer=received.subarray(2,length+2);
      if(received.length!==length+2 ||
         !dnsResponseMatchesQuestion(question,answer)){
        stop(Error('Verified DoT upstream returned unrelated question'));return;
      }
      stop(undefined,Buffer.from(answer));
    });
  });
}
