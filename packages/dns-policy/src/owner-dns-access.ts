import {parseDnsQuestion,servfailDnsResponse,type Classifier,type DnsResolver} from './personal-dot-gateway-core.ts';

export type OwnerDnsStatus=(label:string)=>Promise<string>;
export type OwnerVideoRoute='vpn_origin'|'smart_dns';

/** A link's video routing is explicit and immutable, not inferred from a
 * loopback address, an unverified VPN indication or the requested domain.
 * ALLOWED remains the legacy owner VPN-origin policy for compatibility.
 */
export function ownerVideoRouteForStatus(value:string):OwnerVideoRoute|null{
  if(value==='ALLOWED')return 'vpn_origin';
  if(value==='ALLOWED_SMART_DNS')return 'smart_dns';
  return null;
}

/** Check credential before and after DNS resolution, including both the
 * validity and the routing policy. A newly revoked/changed link fails closed.
 */
export async function resolveOwnerDnsMessage(
  label:string,wire:Uint8Array,status:OwnerDnsStatus,classify:Classifier,
  mapped:DnsResolver,direct:DnsResolver,signal?:AbortSignal,
):Promise<Uint8Array>{
  try{
    if(signal?.aborted)return servfailDnsResponse(wire);
    const before=await status(label);
    const videoRoute=ownerVideoRouteForStatus(before);
    if(!videoRoute)return servfailDnsResponse(wire);
    const question=parseDnsQuestion(wire);
    const video=question.name==='googlevideo.com'||question.name.endsWith('.googlevideo.com');
    let answer:Uint8Array;
    if(video&&[28,64,65].includes(question.type)){
      // Keep the IPv4-only CDN policy consistent across both owner modes.
      // Never return an unverified IPv6 address / HTTPS alias that bypasses
      // the explicitly selected video route.
      const nodata=Buffer.from(servfailDnsResponse(wire));
      nodata.writeUInt16BE(nodata.readUInt16BE(2)&0xfff0,2);
      answer=nodata;
    }else{
      // Only Smart DNS links map video CDN to the checked foreign ingress.
      // Old VPN-origin links continue to preserve original CDN addresses.
      const route=video
        ?(videoRoute==='smart_dns'?'premium':'direct')
        :await classify(question);
      if(route!=='direct'&&route!=='premium')return servfailDnsResponse(wire);
      answer=await (route==='premium'?mapped:direct)(wire,signal);
    }
    if(signal?.aborted||await status(label)!==before)return servfailDnsResponse(wire);
    return answer;
  }catch{return servfailDnsResponse(wire);}
}
