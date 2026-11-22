/**
 * Additional verified country-labelled nodes for the EXISTING /sub/<token>.
 *
 * Release-gated, read-only. No node can become usable through a DB status
 * alone: a recent Ed25519 receipt must bind its exact VLESS URI to the live
 * entitlement revision/expiry and the verified egress evidence.
 * The signing private key is NOT available to the website/LLM.
 */
import {createPublicKey,verify,type KeyObject} from 'node:crypto';
import {isIP} from 'node:net';
import type {Pool} from 'pg';
import {vpnCountryLabel} from './incy-subscription-presentation.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NODE_ID=/^[a-z0-9][a-z0-9-]{2,39}$/;
const COUNTRY=/^[A-Z]{2}$/;
const HASH=/^[a-f0-9]{64}$/;
const HOST=/^[a-z0-9](?:[a-z0-9.-]{1,251})[a-z0-9]$/;
const SIG=/^[A-Za-z0-9_-]{86}$/;
const QUERIES=new Set([
  'encryption','security','type','flow','sni','fp','pbk','sid','spx',
]);
const MAX_ADDITIONAL_NODES=20;
const MAX_NODE_HEALTH_AGE_MS=60*60*1000;
const MAX_GRANT_AGE_MS=15*60*1000;

export interface AdditionalNodeReceipt {
  node_id:string;
  country_code:string;
  country_name_ru:string;
  endpoint_host:string;
  endpoint_port:number;
  state:string;
  exit_country_proof_sha256:string;
  vpn_e2e_proof_sha256:string;
  verified_at:Date;
  entitlement_id:string;
  revision:number;
  expires_at:Date;
  observed_at:Date;
  profile_uri:string;
  signature:string;
}
export interface ActiveAdditionalEntitlement {
  entitlementId:string;
  revision:number;
  expiresAt:Date;
}

/** The signer and reader MUST serialize this exact versioned array. */
export function additionalNodeReceiptPayload(r:AdditionalNodeReceipt):Buffer {
  return Buffer.from(JSON.stringify([
    'MNEBYVPN_NODE_ACCESS_V1',
    r.node_id,r.country_code,r.country_name_ru,r.endpoint_host,r.endpoint_port,
    r.exit_country_proof_sha256,r.vpn_e2e_proof_sha256,
    r.entitlement_id,r.revision,r.expires_at.toISOString(),
    r.observed_at.toISOString(),r.profile_uri,
  ]),'utf8');
}

/** Load a read-only Ed25519 SPKI DER public key, never an operator private key. */
export function additionalNodeVerificationKey(base64url:string):KeyObject {
  if(!/^[A-Za-z0-9_-]{58,64}$/.test(base64url))
    throw Error('Invalid additional node verification key');
  const der=Buffer.from(base64url,'base64url');
  const key=createPublicKey({key:der,format:'der',type:'spki'});
  if(key.asymmetricKeyType!=='ed25519'||der.length!==44)
    throw Error('Expected Ed25519 SPKI verification key');
  return key;
}

const validHost=(host:string):boolean=>{
  if(!HOST.test(host)||!host.includes('.')||host.includes('..')||
     isIP(host)||host==='localhost'||host.endsWith('.local')||
     host.endsWith('.internal'))return false;
  return host.split('.').every(label=>
    label.length>=1&&label.length<=63&&
    !label.startsWith('-')&&!label.endsWith('-'));
};

function verifiedUri(row:AdditionalNodeReceipt):boolean {
  let url:URL;
  try{url=new URL(row.profile_uri);}catch{return false;}
  if(url.protocol!=='vless:'||url.hostname!==row.endpoint_host||
     url.port!==String(row.endpoint_port)||!UUID.test(url.username)||
     !!url.password||!!url.hash||(url.pathname!==''&&url.pathname!=='/'))return false;
  const p=url.searchParams;
  if(p.size!==QUERIES.size||[...p.keys()].some(k=>!QUERIES.has(k)))return false;
  const sni=p.get('sni')??'';
  if(!validHost(sni))return false;
  return p.get('encryption')==='none'&&p.get('security')==='reality'&&
    p.get('type')==='tcp'&&p.get('flow')==='xtls-rprx-vision'&&
    (p.get('fp')==='chrome'||p.get('fp')==='firefox')&&
    /^[A-Za-z0-9_-]{43}$/.test(p.get('pbk')??'')&&
    /^[0-9a-f]{16}$/.test(p.get('sid')??'')&&p.get('spx')==='/';
}

function safeRow(row:AdditionalNodeReceipt,owner:ActiveAdditionalEntitlement,
                 key:KeyObject,now:number):boolean {
  if(!NODE_ID.test(row.node_id)||row.node_id.endsWith('-')||
     !COUNTRY.test(row.country_code)||row.country_code==='ZZ'||
     !/^[А-Яа-яЁёA-Za-z ()-]{2,70}$/.test(row.country_name_ru)||
     !validHost(row.endpoint_host)||row.endpoint_host==='cdn.servgo.ru'||
     row.state!=='enabled'||!Number.isInteger(row.endpoint_port)||
     row.endpoint_port<1||row.endpoint_port>65535||
     !HASH.test(row.exit_country_proof_sha256)||
     !HASH.test(row.vpn_e2e_proof_sha256)||
     row.entitlement_id!==owner.entitlementId||!UUID.test(row.entitlement_id)||
     row.revision!==owner.revision||!Number.isSafeInteger(row.revision)||
     !SIG.test(row.signature)||
     !(row.verified_at instanceof Date)||!(row.observed_at instanceof Date)||
     !(row.expires_at instanceof Date)||
     !Number.isFinite(row.verified_at.getTime())||
     !Number.isFinite(row.observed_at.getTime())||
     !Number.isFinite(row.expires_at.getTime())||
     row.expires_at.getTime()<=now||
     Math.abs(row.expires_at.getTime()-owner.expiresAt.getTime())>1000||
     now-row.verified_at.getTime()>MAX_NODE_HEALTH_AGE_MS||
     now-row.observed_at.getTime()>MAX_GRANT_AGE_MS||
     row.verified_at.getTime()>now+120_000||
     row.observed_at.getTime()>now+120_000||
     !verifiedUri(row))return false;
  try{
    const sig=Buffer.from(row.signature,'base64url');
    return sig.length===64&&sig.toString('base64url')===row.signature&&
      verify(null,additionalNodeReceiptPayload(row),key,sig);
  }catch{return false;}
}

/** Never replace, reinterpret, or invalidate the original working node URLs. */
export function verifiedAdditionalVpnLinks(
  rows:readonly AdditionalNodeReceipt[],
  owner:ActiveAdditionalEntitlement,
  key:KeyObject,
  now=Date.now(),
):string[] {
  if(!UUID.test(owner.entitlementId)||!Number.isSafeInteger(owner.revision)||
     owner.revision<1||!Number.isFinite(owner.expiresAt.getTime())||
     owner.expiresAt.getTime()<=now) return [];
  if(rows.length>MAX_ADDITIONAL_NODES)throw Error('Too many additional VPN nodes');
  const names=new Set<string>(),uris:string[]=[];
  for(const row of rows){
    if(names.has(row.node_id)||!safeRow(row,owner,key,now))continue;
    names.add(row.node_id);
    const label=vpnCountryLabel(row.country_name_ru);
    uris.push(row.profile_uri+'#'+encodeURIComponent(label));
  }
  return uris;
}

export async function loadAdditionalVpnLinks(
  pool:Pick<Pool,'query'>,
  owner:ActiveAdditionalEntitlement,
  key:KeyObject,
  now=Date.now(),
):Promise<string[]> {
  // Both site-side opt-in and database release flag must be enabled.
  const result=await pool.query<AdditionalNodeReceipt>(
    'SELECT n.node_id,n.country_code,n.country_name_ru,n.endpoint_host,'+
    'n.endpoint_port,n.state,n.exit_country_proof_sha256,'+
    'n.vpn_e2e_proof_sha256,n.verified_at,'+
    'r.entitlement_id::text,r.revision,r.expires_at,r.observed_at,'+
    'r.profile_uri,r.signature '+
    'FROM vpn_additional_nodes n JOIN vpn_additional_node_receipts r '+
    'ON r.node_id=n.node_id '+
    'WHERE r.entitlement_id=$1 AND r.revision=$2 '+
    "AND EXISTS(SELECT 1 FROM vpn_release_flags WHERE feature='vpn_additional_nodes' AND enabled=true) "+
    'ORDER BY n.country_code,n.node_id LIMIT 21',
    [owner.entitlementId,owner.revision]);
  return verifiedAdditionalVpnLinks(result.rows,owner,key,now);
}
