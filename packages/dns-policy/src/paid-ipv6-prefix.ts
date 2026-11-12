/**
 * Candidate destination-IPv6 derivation for SmartDNS paid entitlements.
 *
 * OFFLINE / NOT AN ADDRESS ALLOCATION OR A PRODUCTION READY FLAG.
 * Requires an independently verified, provider-routed GLOBAL /64 prefix on
 * the same existing foreign VPS. No change to host IPv6 routes or interfaces.
 * Final uniqueness is enforced by the permanent SQL claim registry.
 */
import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';

export type RoutedPrefixEvidence = {
  providerConfirmed: boolean;
  publiclyReachable: boolean;
  ipv4OnlyClientFallbackVerified: boolean;
  serverIsExistingForeignVps: boolean;
};

function ipv6Words(address: string): number[] {
  if (isIP(address) !== 6 || address.includes('%')) throw new Error('Expected IPv6 address');
  const normalized=new URL('http://['+address+']/').hostname.slice(1,-1);
  const sides=normalized.split('::');
  if (sides.length>2)throw new Error('Invalid compressed IPv6');
  const left=sides[0]?sides[0].split(':'):[];
  const right=sides.length===2 && sides[1]?sides[1].split(':'):[];
  const zeros=8-left.length-right.length;
  if ((sides.length===1 && zeros!==0)||(sides.length===2 && zeros<1))
    throw new Error('Invalid IPv6 word count');
  return [...left,...Array.from({length:zeros},()=> '0'),...right].map(x=>{
    const n=Number.parseInt(x,16);
    if(!Number.isInteger(n)||n<0||n>65535)throw new Error('Invalid IPv6 word');
    return n;
  });
}

function fromWords(words:readonly number[]):string {
  // Use URL canonicalization rather than presenting a nonstandard short form.
  return new URL('http://['+words.map(w=>w.toString(16)).join(':')+']/').hostname.slice(1,-1);
}

export function parseGlobalDelegated64(raw:string):string {
  if (typeof raw!=='string'||!raw.endsWith('/64'))throw new Error('Routed /64 is required');
  const words=ipv6Words(raw.slice(0,-3));
  if(words.length!==8||words.slice(4).some(w=>w!==0))
    throw new Error('IPv6 prefix not aligned to /64');
  // The 2000::/3 block is global-unicast allocation space, not proof of a
  // globally routed *specific* prefix. Reject 2001:db8:: documentation range.
  if((words[0]&0xe000)!==0x2000 ||
     (words[0]===0x2001 && words[1]===0x0db8))
    throw new Error('IPv6 prefix not valid as a public allocation');
  return fromWords(words)+'/64';
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Deterministic candidate, NOT a unique binding until the SQL claim succeeds.
 * HMAC prevents guessable sequential addresses, but the resulting destination
 * IPv6 itself is a transferable bearer capability, not a user authentication.
 */
export function candidateDestinationIPv6(
  routedPrefix:string,
  entitlementId:string,
  allocationKey:Uint8Array,
  attempt=0,
):string {
  const canonical=parseGlobalDelegated64(routedPrefix);
  if(!uuid.test(entitlementId)||allocationKey.length<32||
     !Number.isSafeInteger(attempt)||attempt<0||attempt>255)
    throw new Error('Invalid private candidate input');
  const prefixWords=ipv6Words(canonical.slice(0,-3)).slice(0,4);
  const digest=createHmac('sha256',allocationKey)
    .update('mnebydns-dest-ipv6-v1\0').update(canonical).update('\0')
    .update(entitlementId.toLowerCase()).update('\0')
    .update(String(attempt)).digest();
  const iid=Array.from({length:4},(_,i)=>digest.readUInt16BE(i*2));
  if(iid.every(w=>w===0))throw new Error('Reserved zero interface identifier');
  return fromWords([...prefixWords,...iid]);
}

export function ipv6PaidLaunchCandidate(
  prefix:string|null,
  evidence:RoutedPrefixEvidence,
):{candidate:boolean;reasons:string[];productionCheckoutEnabled:false} {
  const reasons:string[]=[];
  if(prefix===null)reasons.push('NO_DELEGATED_PREFIX');
  else {try{parseGlobalDelegated64(prefix);}catch{reasons.push('INVALID_DELEGATED_PREFIX');}}
  if(!evidence.serverIsExistingForeignVps)reasons.push('WRONG_SERVER');
  if(!evidence.providerConfirmed)reasons.push('PROVIDER_ROUTING_UNVERIFIED');
  if(!evidence.publiclyReachable)reasons.push('EXTERNAL_IPV6_REACHABILITY_UNVERIFIED');
  if(!evidence.ipv4OnlyClientFallbackVerified)reasons.push('IPV4_ONLY_CLIENT_UNVERIFIED');
  // A candidate isn't live approval: network, per-flow attribution, revocation,
  // real quota enforcement and end-user tests still need independent evidence.
  return{candidate:reasons.length===0,reasons,productionCheckoutEnabled:false};
}
