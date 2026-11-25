/**
 * Proposed country-scoped PERSONAL DoT bearer identity contract.
 *
 * NOT connected to checkout, entitlement issuance, Telegram, DNS records,
 * TLS listeners or routing. Do not expose a candidate hostname to customers
 * until country-bound, signed node policy and external authenticated E2E pass.
 *
 * Dedicated country zones allow independent country ingress (different A/AAAA
 * and dedicated wildcard TLS certs). The existing single-level
 * *.dns.mnebyvpn.site profiles remain byte-for-byte compatible.
 */
import {createHash} from 'node:crypto';
import {makePersonalDoTIdentity} from './personal-dot-identity.ts';

export type RegionalDnsCountry='FI'|'DE';
export type RegionalDnsCandidate={
  countryCode:RegionalDnsCountry;
  label:string;
  hostname:string;
  /** FI country-separated digest; DE retains legacy digest for compatibility. */
  tokenSha256:string;
  readyForCustomerRelease:false;
};
const COUNTRY_ZONE:Readonly<Record<RegionalDnsCountry,string>>=Object.freeze({
  FI:'fi.mnebyvpn.site',
  DE:'dns.mnebyvpn.site',
});
const LABEL=/^[a-z0-9]{12}$/;
const HOST=/^([a-z0-9]{12})\.(fi|dns)\.mnebyvpn\.site$/;

function approvedCountry(value:unknown):RegionalDnsCountry {
  if(value!=='FI'&&value!=='DE')throw Error('Unsupported regional DNS country');
  return value;
}

/**
 * Build an UNPUBLISHED candidate only. The real issuer must check a signed
 * node-country receipt, release flag, entitlement, local authorization
 * snapshot and live strict DoT E2E before sending any country profile.
 */
export function proposeRegionalPersonalDnsIdentity(
  country:RegionalDnsCountry,entropy?:Uint8Array,
):RegionalDnsCandidate{
  const code=approvedCountry(country);
  const identity=makePersonalDoTIdentity(undefined,entropy);
  if(!LABEL.test(identity.label))throw Error('Invalid personal DNS label');
  const hostname=identity.label+'.'+COUNTRY_ZONE[code];
  return {
    countryCode:code,label:identity.label,hostname,
    tokenSha256:code==='DE'?identity.tokenSha256:createHash('sha256')
      .update('MNEBYVPN_COUNTRY_DNS_V1\0'+code+'\0'+identity.label,'ascii')
      .digest('hex'),
    readyForCustomerRelease:false,
  };
}

/** Exact match only; Germany retains the legacy DNS zone and digest. */
export function parseRegionalPersonalDnsHostname(value:unknown):
    {countryCode:RegionalDnsCountry;label:string}|null{
  if(typeof value!=='string'||value!==value.trim()||value.includes(':')||
     value.includes('/')||value.includes('*')||value.includes('\\'))return null;
  const normalized=value.toLowerCase().replace(/\.$/,'');
  const match=HOST.exec(normalized);
  if(!match)return null;
  return {countryCode:match[2]==='fi'?'FI':'DE',label:match[1]};
}

/** Non-publishing display label for bot/site country picker. */
export function regionalDnsDisplayLabel(country:RegionalDnsCountry):string{
  return approvedCountry(country)==='FI'?'🇫🇮 Финляндия':'🇩🇪 Германия';
}
