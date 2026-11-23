/**
 * Dormant RU188 -> FI217 signed personal DoT grant snapshot V1.
 * Wire-compatible with nodekit/fi_dns_signed_grants.py in telegram-proxy-infra.
 *
 * This pure function NEVER queries orders, grants entitlements, writes files,
 * publishes customer hostnames or loads a private key. The trusted isolated
 * controller worker must verify paid rights and own a root-only KeyObject.
 */
import {sign, type KeyObject} from 'node:crypto';

export const FI_DNS_NODE='fi-test-01';
export const FI_DNS_COUNTRY='FI';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const MAX_ROWS=2048;
const GRANT_KEYS=['entitlementId','credentialRevision','tokenSha256','expiresAt','state'] as const;

export type FiDnsGrant={
  entitlementId:string;credentialRevision:number;
  tokenSha256:string;expiresAt:string;state:'ACTIVE'|'REVOKED';
};
export type FiDnsUnsignedSnapshot={
  schemaVersion:1;nodeId:'fi-test-01';countryCode:'FI';revision:number;
  issuedAt:string;validUntil:string;grants:FiDnsGrant[];
};
export type FiDnsSignedSnapshot=FiDnsUnsignedSnapshot&{signature:string};

function instant(v:string):number {
  if(!UTC.test(v))throw Error('Noncanonical FI DNS UTC millisecond timestamp');
  const t=Date.parse(v);
  if(!Number.isFinite(t)||new Date(t).toISOString()!==v)
    throw Error('Invalid FI DNS UTC instant');
  return t;
}
function signedRows(rows:FiDnsGrant[],issuedAtMs:number):FiDnsGrant[] {
  if(!Array.isArray(rows)||rows.length>MAX_ROWS)
    throw Error('Invalid regional DNS grant count');
  // Returned rows are serialized as JSON. Reject extra fields BEFORE
  // signing so an unknown plaintext token/metadata cannot be published in a
  // cryptographically unsigned envelope field.
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row)||
      Object.keys(row).length!==GRANT_KEYS.length||
      !GRANT_KEYS.every(key=>Object.prototype.hasOwnProperty.call(row,key))||
      typeof row.entitlementId!=='string'||
      typeof row.tokenSha256!=='string'||
      typeof row.expiresAt!=='string')
      throw Error('Unsafe FI DNS grant schema');
  }
  const seen=new Set<string>();
  const sorted=[...rows].sort((a,b)=>a.tokenSha256<b.tokenSha256?-1:a.tokenSha256>b.tokenSha256?1:0);
  let prev='';
  for(const row of sorted){
    if(!row||!UUID.test(row.entitlementId)||
      !Number.isSafeInteger(row.credentialRevision)||
      row.credentialRevision<1||row.credentialRevision>1_000_000_000||
      !SHA.test(row.tokenSha256)||row.tokenSha256<=prev||
      seen.has(row.entitlementId)||
      (row.state!=='ACTIVE'&&row.state!=='REVOKED')||
      instant(row.expiresAt)>issuedAtMs+366*86400_000)
      throw Error('Untrusted FI DNS entitlement grant');
    prev=row.tokenSha256;
    seen.add(row.entitlementId);
  }
  return sorted.map(g=>({
    entitlementId:g.entitlementId,credentialRevision:g.credentialRevision,
    tokenSha256:g.tokenSha256,expiresAt:g.expiresAt,state:g.state,
  }));
}
export function fiDnsSnapshotTranscript(data:FiDnsUnsignedSnapshot):Buffer{
  return Buffer.from(JSON.stringify([
    'MNEBYVPN_REGIONAL_DNS_SNAPSHOT_V1',
    data.nodeId,data.countryCode,data.revision,data.issuedAt,
    data.validUntil,
    data.grants.map(g=>[g.entitlementId,g.credentialRevision,
      g.tokenSha256,g.expiresAt,g.state]),
  ]),'utf8');
}
export function signFiPersonalDnsSnapshot(
  input:{revision:number;issuedAt:string;validUntil:string;grants:FiDnsGrant[]},
  signer:KeyObject, nowMs=Date.now(),
):FiDnsSignedSnapshot{
  if(signer.type!=='private'||signer.asymmetricKeyType!=='ed25519')
    throw Error('Isolated RU188 Ed25519 controller key required');
  if(!Number.isSafeInteger(input.revision)||input.revision<1||
     input.revision>1_000_000_000||!Number.isSafeInteger(nowMs))
    throw Error('Untrusted FI DNS snapshot revision/time');
  const issued=instant(input.issuedAt),end=instant(input.validUntil);
  if(nowMs<issued-15_000||nowMs>issued+120_000||
     end<=issued||end>issued+120_000||end<=nowMs)
    throw Error('Expired, future or oversized FI DNS signed snapshot');
  const data:FiDnsUnsignedSnapshot={
    schemaVersion:1,nodeId:FI_DNS_NODE,countryCode:FI_DNS_COUNTRY,
    revision:input.revision,issuedAt:input.issuedAt,validUntil:input.validUntil,
    grants:signedRows(input.grants,issued),
  };
  return {...data,signature:sign(null,fiDnsSnapshotTranscript(data),signer)
    .toString('base64url')};
}
