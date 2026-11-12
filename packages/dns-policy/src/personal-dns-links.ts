/**
 * PERSONAL DNS CREDENTIAL FORMAT — not a deployed DoT/DoH server.
 *
 * For Android, the generated hostname fits the Private DNS provider field.
 * For Apple, DoH uses an individually identifiable path or a mobileconfig
 * profile created from the same per-entitlement link.
 *
 * The hostname is a transferable credential, NOT proof of a physical device.
 * SNI can be visible on the network. Neither a DNS query count nor a DNS
 * credential proves the number of actual HTTPS connections.
 */
import {createHash, createHmac} from 'node:crypto';

export const DNS_PUBLIC_HOST='dns.mnebyvpn.site';
export const DNS_MONTHLY_QUERY_ALLOWANCE=1_000_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL=/^p-([a-z2-7]{32})$/;

export type PersonalDnsLinks={
  dotHostname:string;
  dohUrl:string;
  tokenDigest:string;
  credentialRevision:number;
};

/** RFC 4648 base32 lowercase (unpadded). Avoids invalid hostname characters. */
function base32(input:Uint8Array):string{
  const abc='abcdefghijklmnopqrstuvwxyz234567';
  let bits=0,bucket=0,out='';
  for(const byte of input){
    bucket=(bucket<<8)|byte;
    bits+=8;
    while(bits>=5){
      out+=abc[(bucket>>>(bits-5))&31];
      bits-=5;
      bucket&=(1<<bits)-1;
    }
  }
  if(bits>0)out+=abc[(bucket<<(5-bits))&31];
  return out;
}

export function personalDnsLinks(
  entitlementId:string,
  revision:number,
  signingKey:Uint8Array,
):PersonalDnsLinks{
  if(!UUID.test(entitlementId)||!Number.isSafeInteger(revision)||
     revision<1||revision>2_147_483_647||!(signingKey instanceof Uint8Array)||
     signingKey.byteLength<32)
    throw new Error('Invalid DNS credential input');
  const digest=createHmac('sha256',signingKey)
    .update('mnebydns-personal-dns-v1\0')
    .update(entitlementId.toLowerCase()).update('\0')
    .update(String(revision)).digest();
  // A 160-bit, securely derived pseudorandom bearer name; not a user ID.
  const label='p-'+base32(digest.subarray(0,20));
  return {
    dotHostname:label+'.'+DNS_PUBLIC_HOST,
    dohUrl:'https://'+DNS_PUBLIC_HOST+'/dns-query/'+label,
    tokenDigest:createHash('sha256').update(label).digest('hex'),
    credentialRevision:revision,
  };
}

/** Parser for BOTH the DoT TLS SNI name and the DoH path. */
export function credentialDigestFromDoT(hostname:string):string|null{
  if(typeof hostname!=='string'||hostname.length>253)return null;
  const suffix='.'+DNS_PUBLIC_HOST;
  const name=hostname.toLowerCase().replace(/\.$/,'');
  if(!name.endsWith(suffix))return null;
  const label=name.slice(0,-suffix.length);
  if(!LABEL.test(label))return null;
  return createHash('sha256').update(label).digest('hex');
}

export function credentialDigestFromDoH(pathname:string):string|null{
  if(typeof pathname!=='string'||pathname.length>200)return null;
  const match=/^\/dns-query\/(p-[a-z2-7]{32})$/.exec(pathname);
  return match?createHash('sha256').update(match[1]).digest('hex'):null;
}

/**
 * Count only lookups that would actually receive a proxied answer. All other
 * DNS queries must retain ordinary resolver behavior, even on expired quota.
 * Enforcement integration MUST share the deployed, exact routing policy.
 */
export function countableProxiedQuestion(
  domain:string,
  qtype:number,
  deployedExactAHostnames:ReadonlySet<string>,
):boolean{
  if(typeof domain!=='string'||qtype!==1||domain.length>253)return false;
  const d=domain.toLowerCase().replace(/\.$/,'');
  return deployedExactAHostnames.has(d);
}

/** Used in the customer's cabinet; never represent DNS queries as page views. */
export function queryQuotaView(used:number,limit:number,periodEnd:Date){
  if(!Number.isSafeInteger(used)||used<0||!Number.isSafeInteger(limit)||
     limit<0||used>limit||!Number.isFinite(periodEnd.getTime()))
    throw new Error('Invalid DNS query usage');
  const remaining=limit-used;
  return {
    metric:'proxied_dns_queries' as const,
    used,limit,remaining,
    exhausted:remaining===0,
    expiresAt:periodEnd.toISOString(),
    renewalAction:remaining===0?'renew_dns_package' as const:null,
  };
}
