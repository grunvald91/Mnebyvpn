import {createHash,randomBytes} from 'node:crypto';

/**
 * Compact 12-symbol DNS-over-TLS bearer label (36^12 possible values).
 * Usernames/devices are NOT encoded; TLS SNI is visible on some networks.
 * Random label is not cryptographic user authentication or device binding.
 *
 * An actual DoT gateway, wildcard DNS/TLS and rate limiting are still needed.
 */
const ALPHABET='0123456789abcdefghijklmnopqrstuvwxyz';
const LABEL=/^[a-z0-9]{12}$/;
const LABEL_SPACE=36n**12n;
const ENTROPY_BITS=128n;
const ENTROPY_LIMIT=(1n<<ENTROPY_BITS)/LABEL_SPACE*LABEL_SPACE;
const PERSONAL_ZONE='dns.mnebyvpn.site';
export const PERSONAL_DOT_LABEL_LENGTH=12;
export const DEFAULT_DNS_QUERY_LIMIT_PER_30D=1_000_000;

/**
 * Unbiased rejection sampling from 128 secure random bits.
 * A supplied sample is for deterministic OFFLINE tests only; a production
 * call with no explicit entropy securely retries if its sample is rejected.
 */
function encodeLabel(sample:Uint8Array):string|null {
  if(sample.length!==16)throw new Error('Expected 128 random bits');
  const n=BigInt('0x'+Buffer.from(sample).toString('hex'));
  if(n>=ENTROPY_LIMIT)return null;
  let value=n%LABEL_SPACE;
  let label='';
  for(let i=0;i<PERSONAL_DOT_LABEL_LENGTH;i++){
    label=ALPHABET[Number(value%36n)]+label;
    value/=36n;
  }
  return label;
}

export interface PersonalDoTIdentity {
  label:string;
  hostname:string;
  tokenSha256:string;
  /** Planned quota per fixed 30-day billing window, NOT HTTPS connections. */
  queryLimitPer30d:number;
}

function canonicalZone(dnsZone:string):string {
  if(typeof dnsZone!=='string')throw new Error('Invalid DNS zone');
  const z=dnsZone.toLowerCase().replace(/\.$/,'');
  if(z!==PERSONAL_ZONE)throw new Error('Unapproved DoT DNS zone');
  return z;
}

export function makePersonalDoTIdentity(
  dnsZone=PERSONAL_ZONE,
  entropy?:Uint8Array,
):PersonalDoTIdentity{
  const zone=canonicalZone(dnsZone);
  if(entropy!==undefined && !(entropy instanceof Uint8Array))
    throw new Error('Expected Uint8Array entropy');
  let label:string|null;
  if(entropy!==undefined){
    // Invalid inputs never silently fall back to weaker randomness.
    label=encodeLabel(entropy);
    if(label===null)throw new Error('Rejected deterministic test sample');
  } else {
    do {label=encodeLabel(randomBytes(16));} while(label===null);
  }
  if(!LABEL.test(label))throw new Error('Invalid random DNS label');
  return{
    label,
    hostname:label+'.'+zone,
    tokenSha256:createHash('sha256').update(label,'ascii').digest('hex'),
    queryLimitPer30d:DEFAULT_DNS_QUERY_LIMIT_PER_30D,
  };
}

export function parsePersonalDoTHostname(
  value:string,
  dnsZone=PERSONAL_ZONE,
):string|null{
  if(typeof value!=='string'||value.includes('*')||value.includes('/')||
    value.includes(':')||value.includes('\\')||value.trim()!==value)
    return null;
  let zone:string;
  try{zone=canonicalZone(dnsZone);}catch{return null;}
  const normalized=value.toLowerCase().replace(/\.$/,'');
  const suffix='.'+zone;
  if(!normalized.endsWith(suffix))return null;
  const label=normalized.slice(0,-suffix.length);
  return LABEL.test(label)?label:null;
}
