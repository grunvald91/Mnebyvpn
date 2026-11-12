import {parsePersonalDoTHostname} from './personal-dot-identity.ts';

/**
 * Pure policy core for a future *separate* TLS/DoT listener on the existing VPS.
 * No socket is opened here. TLS authentication, DNS/TCP framing, route policy
 * source, throttling and upstream forwarding belong to a separate canary.
 */
export type DnsRoute='premium'|'direct';
export interface DnsQuestion {
  name:string;
  type:number;
  dnsClass:number;
}
export type Classifier=(query:DnsQuestion)=>Promise<DnsRoute>|DnsRoute;
export type DnsResolver=(wire:Uint8Array)=>Promise<Uint8Array>;
export type DnsUsageAuthorizer=(label:string)=>Promise<string>;

const MAX_MESSAGE_SIZE=16384;

export function parseDnsQuestion(wire:Uint8Array):DnsQuestion{
  if(!(wire instanceof Uint8Array)||wire.length<17||
    wire.length>MAX_MESSAGE_SIZE)throw new Error('Invalid DNS message length');
  const view=Buffer.from(wire.buffer,wire.byteOffset,wire.byteLength);
  const flags=view.readUInt16BE(2);
  const qdcount=view.readUInt16BE(4);
  // Reject responses, dynamic updates, compressed/ambiguous QNAME and
  // multi-question requests; never charge before deciding a route.
  if((flags&0x8000)!==0||(flags&0x7800)!==0||qdcount!==1)
    throw new Error('Unsupported DNS question');
  const labels:string[]=[];
  let pos=12,total=1;
  for(let i=0;i<127;i++){
    if(pos>=view.length)throw new Error('Truncated DNS question');
    const length=view[pos++];
    if(length===0){
      if(!labels.length||pos+4>view.length)throw new Error('Empty/truncated DNS question');
      const type=view.readUInt16BE(pos);
      const dnsClass=view.readUInt16BE(pos+2);
      if(dnsClass!==1)throw new Error('Only IN DNS class allowed');
      return{name:labels.join('.').toLowerCase(),type,dnsClass};
    }
    if(length>63||pos+length>view.length)throw new Error('Invalid DNS label');
    total+=length+1;
    if(total>255)throw new Error('DNS QNAME too long');
    const bytes=view.subarray(pos,pos+length);
    // A literal '.' inside a wire label must not be mistaken for an actual
    // DNS label boundary by the authoritative route classifier.
    if(bytes.some(byte=>!
        ((byte>=48&&byte<=57)||(byte>=65&&byte<=90)||
         (byte>=97&&byte<=122)||byte===45||byte===95)))
      throw new Error('Invalid DNS label bytes');
    labels.push(bytes.toString('ascii'));
    pos+=length;
  }
  throw new Error('Too many DNS labels');
}

/**
 * After a customer's quota is used or a subscription is inactive,
 * fall back to trusted DIRECT upstream DNS, not to the SmartDNS-mapped
 * CoreDNS zone. This preserves ordinary websites instead of breaking
 * the phone's entire "Private DNS" connection.
 *
 * It is NOT a paid SNI proxy authorization: clients can still directly
 * reach an independently open HTTPS proxy. That bypass must be fixed.
 */
export async function resolvePersonalDnsMessage(
  tlsSni:string,
  dnsWire:Uint8Array,
  classify:Classifier,
  consume:DnsUsageAuthorizer,
  mapped:DnsResolver,
  direct:DnsResolver,
):Promise<Uint8Array>{
  const label=parsePersonalDoTHostname(tlsSni);
  if(!label)throw new Error('Unknown DoT identity');
  const question=parseDnsQuestion(dnsWire);
  const route=await classify(question);
  if(route==='direct')return direct(dnsWire);
  if(route!=='premium')throw new Error('Untrusted DNS route classification');
  let status:string;
  try{
    status=await consume(label);
  }catch{
    // A DB failure never opens unbilled SmartDNS routes; normal DNS only.
    return direct(dnsWire);
  }
  if(status==='ALLOWED')return mapped(dnsWire);
  // Quota expired, refunded, unknown: no mapped answer.
  return direct(dnsWire);
}
