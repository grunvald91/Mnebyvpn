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
    const route=await classify(parseDnsQuestion(wire));
    if(route!=='direct'&&route!=='premium')return servfailDnsResponse(wire);
    const answer=await (route==='premium'?mapped:direct)(wire,signal);
    if(signal?.aborted||await status(label)!=='ALLOWED')return servfailDnsResponse(wire);
    return answer;
  }catch{return servfailDnsResponse(wire);}
}
