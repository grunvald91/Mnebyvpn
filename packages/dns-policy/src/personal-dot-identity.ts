import {createHash, randomBytes} from 'node:crypto';

/**
 * Private DNS / DoT identity on the existing MNEBYDNS hostname.
 *
 * The hostname itself is a transferable bearer label: TLS SNI is NOT a
 * cryptographic user identity and may be observed on the network.
 * Never claim that this binds a request to an individual physical device.
 *
 * DNS resolver needs a wildcard A/AAAA record and an appropriate TLS
 * wildcard certificate. Neither is installed by this module.
 */
const ALPHABET='abcdefghijklmnopqrstuvwxyz234567';
const LABEL=/^d[a-z2-7]{26}$/;
export const DEFAULT_DNS_QUERY_LIMIT_PER_30D=1_000_000;

export function encodeBase32(bytes:Uint8Array):string{
  let accumulator=0, bits=0, out='';
  for(const byte of bytes){
    accumulator=((accumulator<<8)|byte)&0xffff;
    bits+=8;
    while(bits>=5){
      bits-=5;
      out+=ALPHABET[(accumulator>>>bits)&31];
    }
  }
  if(bits)out+=ALPHABET[(accumulator<<(5-bits))&31];
  return out;
}

export interface PersonalDoTIdentity {
  label:string;
  hostname:string;
  tokenSha256:string;
  /** Planned quota per fixed 30-day billing window, NOT connections. */
  queryLimitPer30d:number;
}

export function makePersonalDoTIdentity(
  dnsZone='dns.mnebyvpn.site',
  entropy?:Uint8Array,
):PersonalDoTIdentity{
  const canonical=dnsZone.toLowerCase().replace(/\.$/,'');
  if(canonical!=='dns.mnebyvpn.site')throw new Error('Unapproved DoT DNS zone');
  const random=entropy===undefined?randomBytes(16):Uint8Array.from(entropy);
  if(random.length!==16)throw new Error('Expected 128 random bits for hostname');
  const label='d'+encodeBase32(random);
  if(!LABEL.test(label))throw new Error('Generated invalid DoT label');
  return{
    label,
    hostname:`${label}.${canonical}`,
    tokenSha256:createHash('sha256').update(label,'ascii').digest('hex'),
    queryLimitPer30d:DEFAULT_DNS_QUERY_LIMIT_PER_30D,
  };
}

export function parsePersonalDoTHostname(
  value:string,
  dnsZone='dns.mnebyvpn.site',
):string|null{
  if(typeof value!=='string'||value.includes('*')||value.includes('/')||
     value.includes(':')||value!==value.toLowerCase())return null;
  const suffix='.'+dnsZone.toLowerCase();
  if(!value.endsWith(suffix))return null;
  const label=value.slice(0,-suffix.length);
  return LABEL.test(label)?label:null;
}
