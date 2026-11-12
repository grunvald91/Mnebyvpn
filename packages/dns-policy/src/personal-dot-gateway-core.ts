import {randomUUID} from 'node:crypto';
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
export type DnsResolver=(wire:Uint8Array,signal?:AbortSignal)=>Promise<Uint8Array>;
export type DnsUsageAuthorizer=(label:string)=>Promise<string>;

const MAX_MESSAGE_SIZE=16384;

export function parseDnsQuestion(wire:Uint8Array):DnsQuestion{
  if(!(wire instanceof Uint8Array)||wire.length<17||
    wire.length>MAX_MESSAGE_SIZE)throw new Error('Invalid DNS message length');
  const view=Buffer.from(wire.buffer,wire.byteOffset,wire.byteLength);
  const flags=view.readUInt16BE(2);
  const qdcount=view.readUInt16BE(4);
  const answerCount=view.readUInt16BE(6);
  const authorityCount=view.readUInt16BE(8);
  const additionalCount=view.readUInt16BE(10);
  // Reject responses, dynamic updates, compressed/ambiguous QNAME,
  // multi-question messages and malformed headers. Permit one DNS EDNS
  // OPT record (widely used on modern phones) but no unsigned extras.
  if((flags&0x8000)!==0||(flags&0x7800)!==0||qdcount!==1||
      answerCount!==0||authorityCount!==0||additionalCount>1)
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
      const end=pos+4;
      if(additionalCount===0){
        if(end!==view.length)throw new Error('Unexpected trailing DNS data');
      } else {
        // EDNS OPT: single root owner, TYPE=41, fixed 11-byte header,
        // and exact declared RDLENGTH. Prevent a different resolver from
        // interpreting a hidden/unvalidated second question or record.
        if(end+11>view.length||view[end]!==0||
           view.readUInt16BE(end+1)!==41)
          throw new Error('Unsupported DNS additional record');
        const rdataLength=view.readUInt16BE(end+9);
        if(end+11+rdataLength!==view.length)
          throw new Error('Truncated or surplus EDNS option data');
      }
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

/** Confirm the upstream DNS reply echoes the exact question we sent.
 * DNS IDs are only 16 bits: an ID match alone cannot validate a response.
 * In a standard response the first question follows the 12-byte header.
 * Compressed/ambiguous question names are intentionally refused here.
 */
export function dnsResponseMatchesQuestion(
  query:Uint8Array,reply:Uint8Array,
):boolean{
  try{
    if(!(reply instanceof Uint8Array)||reply.length<17||
       reply.length>MAX_MESSAGE_SIZE)return false;
    const sent=parseDnsQuestion(query);
    const packet=Buffer.from(reply.buffer,reply.byteOffset,reply.byteLength);
    const request=Buffer.from(query.buffer,query.byteOffset,query.byteLength);
    if(packet.readUInt16BE(0)!==request.readUInt16BE(0)||
       (packet.readUInt16BE(2)&0xF800)!==0x8000||
       packet.readUInt16BE(4)!==1)return false;
    let pos=12,terminated=false;
    for(let i=0;i<127;i++){
      if(pos>=packet.length)return false;
      const length=packet[pos++];
      if(length===0){terminated=true;break;}
      if(length>63||pos+length>packet.length)return false;
      pos+=length;
    }
    if(!terminated||pos+4>packet.length)return false;
    const synthetic=Buffer.alloc(pos+4);
    synthetic.writeUInt16BE(1,4);
    packet.copy(synthetic,12,12,pos+4);
    const echoed=parseDnsQuestion(synthetic);
    return sent.name===echoed.name&&sent.type===echoed.type&&
      sent.dnsClass===echoed.dnsClass;
  }catch{return false;}
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
  let route:DnsRoute;
  try{
    route=await classify(question);
  }catch{
    // Missing/failed route policy must not break ordinary DNS or grant
    // unmetered premium answers: resolve the origin through direct DNS.
    return direct(dnsWire);
  }
  if(route==='direct')return direct(dnsWire);
  if(route!=='premium')throw new Error('Untrusted DNS route classification');
  let status:string;
  try{
    status=await consume(label);
  }catch{
    // A DB failure never opens unbilled SmartDNS routes; normal DNS only.
    return direct(dnsWire);
  }
  if(status==='ALLOWED'){
    try{
      return await mapped(dnsWire);
    }catch{
      // Premium upstream failure should not take down Android Private DNS.
      // The accepted query was already charged; telemetry must track this.
      return direct(dnsWire);
    }
  }
  // Quota expired, refunded, unknown: no mapped answer.
  return direct(dnsWire);
}


export type DnsQueryReserve=(label:string,id:string)=>Promise<string>;
export type DnsQueryFinish=(id:string,successful:boolean)=>Promise<string>;

/** Quota is *settled* only after a verified mapped upstream response.
 * Reserve blocks concurrent oversubscription; release on backend errors.
 * The accounting metric is successful upstream DNS answers, not guaranteed
 * delivery to the handset after TLS writes. Pending reservations expire in SQL.
 */
export async function resolvePersonalDnsWithSettlement(
  tlsSni:string,dnsWire:Uint8Array,classify:Classifier,
  reserve:DnsQueryReserve,finish:DnsQueryFinish,
  mapped:DnsResolver,direct:DnsResolver,
  signal?:AbortSignal,
):Promise<Uint8Array>{
  const label=parsePersonalDoTHostname(tlsSni);
  if(!label)throw Error('Unknown DoT identity');
  const question=parseDnsQuestion(dnsWire);
  if(signal?.aborted)throw Error('DNS request aborted');
  let route:DnsRoute;
  try{route=await classify(question);}
  catch{return direct(dnsWire,signal);}
  if(route==='direct')return direct(dnsWire,signal);
  if(route!=='premium')throw Error('Untrusted DNS route classification');
  const id=randomUUID();
  let status:string;
  try{status=await reserve(label,id);}
  catch{return direct(dnsWire,signal);}
  if(status!=='RESERVED')return direct(dnsWire,signal);
  let released=false;
  const release=async()=>{
    if(released)return;
    released=true;
    try{await finish(id,false);}catch{/* SQL expiry recovers abandoned holds */}
  };
  if(signal?.aborted){await release();throw Error('DNS request aborted');}
  try{
    const result=await mapped(dnsWire,signal);
    if(signal?.aborted||!dnsResponseMatchesQuestion(dnsWire,result)){
      await release();
      if(signal?.aborted)throw Error('DNS request aborted');
      return direct(dnsWire,signal);
    }
    // Do not send a paid mapping if a DB commit failed or the credential was
    // rotated/revoked while this request was in flight.
    const verdict=await finish(id,true);
    released=true;
    if(signal?.aborted)throw Error('DNS request aborted');
    if(verdict==='SETTLED')return result;
    return direct(dnsWire,signal);
  }catch(err){
    await release();
    if(signal?.aborted)throw Error('DNS request aborted');
    return direct(dnsWire,signal);
  }
}
