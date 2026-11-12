/**
 * Fail-closed policy boundary for a future SNI TCP ingress on the existing VPS.
 *
 * OFFLINE CONTRACT. No listener, parser, exposed socket or live billing is wired.
 * The gateway MUST look up the permanent destination-IP claim and entitlement
 * from canonical billing DB. Original TLS SNI is required (ECH/absent SNI DENY).
 */
import {randomUUID} from 'node:crypto';
import {domainToASCII,isIP} from 'node:url';
import {parseGlobalDelegated64} from './paid-ipv6-prefix.ts';

export interface TrustedEntitlement {
  entitlementId:string;
  destinationIPv6:string;
  product:'smart_dns';
  state:string;
  revision:number;
  expiresAt:Date|null;
  quotaState:string;
  quotaRemainingBytes:bigint;
  retiredAt:Date|null;
}
export type AdmissionReason =
  |'ADMIT'|'PREFIX_UNAVAILABLE'|'UNKNOWN_DESTINATION'|'NO_TRUSTED_ENTITLEMENT'
  |'WRONG_PRODUCT'|'INACTIVE'|'EXPIRED'|'QUOTA_EXHAUSTED'
  |'INVALID_SNI'|'UNAPPROVED_SNI'|'INVALID_REVISION';
export interface IngressAdmission {
  admitted:boolean;
  reason:AdmissionReason;
  entitlementId?:string;
  revision?:number;
}
const deny=(reason:AdmissionReason):IngressAdmission=>({admitted:false,reason});

function canonicalV6(ip:string):string|null{
  if(typeof ip!=='string'||isIP(ip)!==6||ip.includes('%'))return null;
  try{return new URL('http://['+ip+']/').hostname.slice(1,-1);}catch{return null;}
}
function normalizedDomain(value:string):string|null{
  if(typeof value!=='string'||!value||value.length>253||value.includes(':')||value.includes('*'))return null;
  if(value.endsWith('.'))value=value.slice(0,-1);
  const ascii=domainToASCII(value).toLowerCase();
  if(!ascii||ascii.length>253||!/^[a-z0-9.-]+$/.test(ascii)||
     !ascii.includes('.')||ascii.split('.').some(part=>!part||part.length>63||
      part.startsWith('-')||part.endsWith('-')))return null;
  return ascii;
}

export function authorizeSniIngress(
  localDestinationIPv6:string,
  originalSni:string,
  allocatedPrefix:string|null,
  trustedGrant:TrustedEntitlement|null,
  approvedHostnames:ReadonlySet<string>,
  now=new Date(),
):IngressAdmission {
  let prefix:string;
  try{prefix=parseGlobalDelegated64(allocatedPrefix??'');}
  catch{return deny('PREFIX_UNAVAILABLE');}
  const local=canonicalV6(localDestinationIPv6);
  if(!local)return deny('UNKNOWN_DESTINATION');
  // Address must be part of this exact delegated /64, not any arbitrary
  // IPv6 address or a connection to the legacy shared IPv4:443.
  const prefix64=prefix.slice(0,-3).split(':').slice(0,4).join(':');
  const local64=new URL('http://['+local+']/').hostname.slice(1,-1).split(':').slice(0,4).join(':');
  if(local64!==prefix64)return deny('UNKNOWN_DESTINATION');
  if(!trustedGrant)return deny('NO_TRUSTED_ENTITLEMENT');
  if(trustedGrant.product!=='smart_dns')return deny('WRONG_PRODUCT');
  if(trustedGrant.retiredAt!==null||trustedGrant.state!=='ACTIVE')return deny('INACTIVE');
  if(!Number.isSafeInteger(trustedGrant.revision)||trustedGrant.revision<1)return deny('INVALID_REVISION');
  if(!trustedGrant.expiresAt||!Number.isFinite(trustedGrant.expiresAt.getTime())||
     trustedGrant.expiresAt.getTime()<=now.getTime())return deny('EXPIRED');
  if(trustedGrant.quotaState!=='AVAILABLE'||trustedGrant.quotaRemainingBytes<=0n)
    return deny('QUOTA_EXHAUSTED');
  if(canonicalV6(trustedGrant.destinationIPv6)!==local)return deny('UNKNOWN_DESTINATION');
  const host=normalizedDomain(originalSni);
  if(!host)return deny('INVALID_SNI');
  if(!approvedHostnames.has(host))return deny('UNAPPROVED_SNI');
  // Admission alone is not enough: every forwarded block MUST be atomically
  // charged against the *current* entitlement state in the canonical DB.
  return{admitted:true,reason:'ADMIT',entitlementId:trustedGrant.entitlementId,revision:trustedGrant.revision};
}

export interface DebitBackend {
  /** Must call existing SERIALIZED debit_smart_dns_quota; fail closed on timeout. */
  debit(entitlementId:string,usageEventId:string,bytes:number):Promise<string>;
}
export interface ByteSink {
  /** Sender must not send any bytes until the prior debit was ACCEPTED. */
  send(bytes:Uint8Array):Promise<void>;
}

/**
 * Basic strict (but latency-heavy) accounting proof: predebit every block
 * before forwarding it. Existing PostgreSQL function checks ACTIVE, expiry,
 * credit quota and serializes concurrent debits under entitlement row lock.
 *
 * Charge policy is intentionally conservative: attempted bytes are charged
 * even if forwarding fails after successful debit. Must be reviewed, measured
 * and replaced by a tested reservation/settlement contract before selling.
 */
export class MeteredChunkGate {
  private readonly entitlementId:string;
  private readonly debitBackend:DebitBackend;
  private readonly sink:ByteSink;
  private tail:Promise<void>=Promise.resolve();
  private stopped=false;

  constructor(admission:IngressAdmission,backend:DebitBackend,sink:ByteSink){
    if(!admission.admitted||admission.reason!=='ADMIT'||!admission.entitlementId)
      throw new Error('Connection admission required');
    this.entitlementId=admission.entitlementId;
    this.debitBackend=backend;
    this.sink=sink;
  }

  forward(input:Uint8Array):Promise<void>{
    const payload=Uint8Array.from(input);
    if(!payload.length)return this.tail;
    if(this.stopped)return Promise.reject(new Error('Ingress is closed'));
    const queued=this.tail.then(async()=>{
      if(this.stopped)throw new Error('Ingress is closed');
      try {
        for(let cursor=0;cursor<payload.length;cursor+=16384){
          const chunk=payload.subarray(cursor,Math.min(cursor+16384,payload.length));
          // A never-reused event ID avoids double charge on mistaken retries.
          // Ambiguous backend outcome FAILS CLOSED: never send unknown-charge data.
          const result=await this.debitBackend.debit(this.entitlementId,randomUUID(),chunk.length);
          if(result!=='ACCEPTED')throw new Error('Debit rejected or unknown');
          await this.sink.send(chunk);
        }
      }catch{
        this.stopped=true;
        throw new Error('Ingress metering or delivery unavailable; connection closed');
      }
    });
    this.tail=queued.catch(()=>{});
    return queued;
  }

  stop():void{this.stopped=true;}
}
