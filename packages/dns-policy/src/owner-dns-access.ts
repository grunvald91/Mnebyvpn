import {parseDnsQuestion,servfailDnsResponse,type Classifier,type DnsResolver} from './personal-dot-gateway-core.ts';

export type OwnerDnsStatus=(label:string)=>Promise<string>;
/** No auth cache: expiry/revoke applies to existing TLS connections too.
 * Check again after upstream resolution before returning a mapped answer.
 */
export async function resolveOwnerDnsMessage(
  label:string,wire:Uint8Array,status:OwnerDnsStatus,classify:Classifier,
  mapped:DnsResolver,direct:DnsResolver,signal?:AbortSignal,
):Promise<Uint8Array>{
  try{
    if(signal?.aborted||await status(label)!=='ALLOWED')return servfailDnsResponse(wire);
    const question=parseDnsQuestion(wire);
    // Different video CDN hostnames must retain their origin addresses inside
    // the owner's VPN. A shared relay IP can merge incompatible connections.
    const video=question.name==='googlevideo.com'||question.name.endsWith('.googlevideo.com');
    let answer:Uint8Array;
    if(video&&[28,64,65].includes(question.type)){
      // The deployed VPN egress is IPv4-only. Suppress IPv6 and service hints,
      // consistently with the existing VPN video-origin DNS policy.
      const nodata=Buffer.from(servfailDnsResponse(wire));
      nodata.writeUInt16BE(nodata.readUInt16BE(2)&0xfff0,2);
      answer=nodata;
    }else{
      const route=video?'direct':await classify(question);
      if(route!=='direct'&&route!=='premium')return servfailDnsResponse(wire);
      answer=await (route==='premium'?mapped:direct)(wire,signal);
    }
    if(signal?.aborted||await status(label)!=='ALLOWED')return servfailDnsResponse(wire);
    return answer;
  }catch{return servfailDnsResponse(wire);}
}
