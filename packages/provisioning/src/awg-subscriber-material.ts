/**
 * Read-only AWG 3.1 connection material for an ALREADY-ACKNOWLEDGED FI peer.
 *
 * A VLESS /sub/<token> feed cannot safely contain an AWG .conf. This module
 * never mints a key, stages a grant, signs a command, changes the release
 * gate, or puts a private key into server logs, HTTP or SQL.
 *
 * The handset generates/stores its own X25519 private key and uses this
 * material locally to assemble an official AmneziaWG 3.1 .conf.
 */
import type {Pool} from 'pg';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY=/^[A-Za-z0-9+/]{43}=$/;
const HASH=/^[a-f0-9]{64}$/;
const IP=/^10\.73\.91\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/;
const NODE='fi-test-01';
const HOST='fi.mnebyvpn.site';
const PORT=51821;
const SUBNET='10.73.91.0/24';

export type AwgSubscriptionOwner={
  entitlementId:string;revision:number;expiresAt:Date;
};
export type VerifiedAwgMaterial={
  protocol:'AmneziaWG 3.1';
  nodeId:'fi-test-01';
  countryCode:'FI';
  countryName:'Финляндия';
  endpoint:'fi.mnebyvpn.site:51821';
  clientAddress:string;
  clientPublicKey:string;
  serverPublicKey:string;
  headerProtectionKey:string;
  mtu:1280;
  expiresAt:string;
};
type AwgDbRow={
  enabled:boolean;
  node_id:string;
  endpoint_host:string;
  listen_port:number;
  subnet_cidr:string;
  pool_state:string;
  verified_at:Date;
  enrollment_status:string;
  server_public_key:string;
  peer_public_key:string;
  client_ipv4:string;
  allocation_state:string;
  allocation_revision:number;
  expires_at:Date;
  outbox_state:string;
  outbox_op:string;
  outbox_billing_revision:number|string;
  outbox_command_sha256:string;
  last_command_sha256:string;
  node_receipt_sha256:string;
  command_peer_key:string;
  command_client_ip:string;
  command_expires_at:string;
  command_entitlement_id:string;
  command_node_id:string;
  command_revision:string;
};

export function isCanonicalAwgPublicKey(value:unknown):value is string{
  if(typeof value!=='string'||!KEY.test(value))return false;
  // Web-standard primitives work on Android/iOS without Node Buffer.
  // Reject noncanonical encodings and all-zero low-order X25519 keys.
  try{
    const raw=atob(value);
    return raw.length===32&&btoa(raw)===value&&
      [...raw].some(char=>char.charCodeAt(0)!==0);
  }catch{return false;}
}
function billRevision(value:unknown):number|null{
  if(typeof value==='number')
    return Number.isSafeInteger(value)&&value>=1?value:null;
  if(typeof value!=='string'||!/^[1-9][0-9]{0,15}$/.test(value))return null;
  const n=Number(value);
  return Number.isSafeInteger(n)&&String(n)===value?n:null;
}

/** Parse the EXACT reviewed FI row, without treating an issued command as an ACK. */
export function verifiedAwgMaterial(
  row:AwgDbRow,owner:AwgSubscriptionOwner,clientPublicKey:string,
  headerProtectionKey:string,expectedServerPublicKey:string,
  now=Date.now(),
):VerifiedAwgMaterial|null{
  if(!UUID.test(owner.entitlementId)||!Number.isSafeInteger(owner.revision)||
     owner.revision<1||!(owner.expiresAt instanceof Date)||
     !Number.isFinite(owner.expiresAt.getTime())||
     owner.expiresAt.getTime()<=now||!Number.isFinite(now)||
     !isCanonicalAwgPublicKey(clientPublicKey)||
     !isCanonicalAwgPublicKey(headerProtectionKey)||
     !isCanonicalAwgPublicKey(expectedServerPublicKey)||
     !row||row.enabled!==true||
     row.node_id!==NODE||row.endpoint_host!==HOST||
     row.listen_port!==PORT||row.subnet_cidr!==SUBNET||
     row.pool_state!=='verified'||row.enrollment_status!=='enrolled'||
     !(row.verified_at instanceof Date)||
     !Number.isFinite(row.verified_at.getTime())||
     // An already applied, independently signed grant must remain visible
     // throughout its valid lease even when periodic E2E probing is delayed.
     // New grants still require fresh independent proof in stageAwgGrant;
     // degraded/disabled pools, revoked or expired peers, and missing ACKs
     // remain fail-closed here.
     row.verified_at.getTime()>now+30000||
     row.server_public_key!==expectedServerPublicKey||
     row.peer_public_key!==clientPublicKey||
     !IP.test(row.client_ipv4)||
     row.allocation_state!=='applied'||
     !Number.isSafeInteger(row.allocation_revision)||
     row.allocation_revision<1||
     !(row.expires_at instanceof Date)||
     !Number.isFinite(row.expires_at.getTime())||
     row.expires_at.getTime()<=now||
     row.expires_at.getTime()>owner.expiresAt.getTime()+1000||
     row.outbox_op!=='grant'||row.outbox_state!=='applied'||
     billRevision(row.outbox_billing_revision)!==owner.revision||
     !HASH.test(row.outbox_command_sha256)||
     row.outbox_command_sha256!==row.last_command_sha256||
     !HASH.test(row.node_receipt_sha256)||
     row.command_peer_key!==clientPublicKey||
     row.command_client_ip!==row.client_ipv4||
     row.command_node_id!==NODE||
     row.command_entitlement_id!==owner.entitlementId||
     row.command_revision!==String(row.allocation_revision)||
     row.command_expires_at!==row.expires_at.toISOString())
    return null;
  return {
    protocol:'AmneziaWG 3.1',nodeId:NODE,
    countryCode:'FI',countryName:'Финляндия',
    endpoint:'fi.mnebyvpn.site:51821',
    clientAddress:row.client_ipv4+'/32',
    clientPublicKey,serverPublicKey:row.server_public_key,
    headerProtectionKey,mtu:1280,
    expiresAt:row.expires_at.toISOString(),
  };
}

/** The site has SELECT access only; any new key must be approved elsewhere
 * by the canonical RU188 signed grant/outbox/ACK pipeline.
 */
export async function loadVerifiedAwgMaterial(
  pool:Pick<Pool,'query'>,owner:AwgSubscriptionOwner,
  clientPublicKey:string,headerProtectionKey:string,
  expectedServerPublicKey:string,subscriptionTokenSha256:string,
  now=Date.now(),
):Promise<VerifiedAwgMaterial|null>{
  if(!isCanonicalAwgPublicKey(clientPublicKey)||
     !isCanonicalAwgPublicKey(headerProtectionKey)||
     !isCanonicalAwgPublicKey(expectedServerPublicKey)||
     !HASH.test(subscriptionTokenSha256)||
     !Number.isSafeInteger(owner.revision)||owner.revision<1||
     !(owner.expiresAt instanceof Date)||
     !Number.isFinite(owner.expiresAt.getTime())||
     !UUID.test(owner.entitlementId))return null;
  const query=
    'SELECT f.enabled,p.node_id,p.endpoint_host,p.listen_port,'+
    'p.subnet_cidr::text,p.state AS pool_state,p.verified_at,'+
    'n.status AS enrollment_status,p.server_public_key,'+
    'a.peer_public_key,host(a.client_ipv4) AS client_ipv4,'+
    'a.state AS allocation_state,a.revision AS allocation_revision,'+
    'a.expires_at,o.state AS outbox_state,o.op AS outbox_op,'+
    'o.billing_revision AS outbox_billing_revision,'+
    'o.command_sha256 AS outbox_command_sha256,'+
    'a.last_command_sha256,o.node_receipt_sha256,'+
    "o.signed_command->>'peerPublicKey' AS command_peer_key,"+
    "o.signed_command->>'clientIpv4' AS command_client_ip,"+
    "o.signed_command->>'expiresAt' AS command_expires_at,"+
    "o.signed_command->>'entitlementId' AS command_entitlement_id,"+
    "o.signed_command->>'nodeId' AS command_node_id,"+
    "o.signed_command->>'revision' AS command_revision "+
    'FROM vpn_awg_peer_allocations a '+
    'JOIN vpn_awg_node_pools p ON p.node_id=a.node_id '+
    'JOIN vpn_node_enrollment_inventory n ON n.node_id=a.node_id '+
    'JOIN vpn_release_flags f ON f.feature=$3 '+
    // Recheck the bearer, subscription and current billing revision in
    // this SAME query. The earlier subscriptionOwner() check can race a
    // revoke/expiry/renewal and is not sufficient authorization by itself.
    'JOIN entitlements e ON e.id=a.entitlement_id '+
    'JOIN provisioning_state v ON v.entitlement_id=e.id '+
    "AND v.adapter='vpn' AND v.applied_revision=e.revision "+
    'AND v.last_observed_at IS NOT NULL '+
    'JOIN vpn_subscription_links l ON l.entitlement_id=e.id '+
    'AND l.token_sha256=$5 AND l.revoked_at IS NULL '+
    'JOIN vpn_awg_command_outbox o ON '+
    'o.node_id=a.node_id AND o.entitlement_id=a.entitlement_id '+
    "AND o.revision=a.revision AND o.op='grant' "+
    'WHERE a.node_id=$4 AND a.entitlement_id=$1 '+
    'AND a.peer_public_key=$2 '+
    "AND e.product='vpn' AND e.state='ACTIVE' "+
    'AND e.revision=$6 AND e.expires_at>clock_timestamp() '+
    "AND e.expires_at BETWEEN $7::timestamptz - interval '1 millisecond' "+
    "AND $7::timestamptz + interval '1 millisecond' "+
    'LIMIT 2';
  const result=await pool.query<AwgDbRow>(
    query,[owner.entitlementId,clientPublicKey,'vpn_awg_clients',NODE,
      subscriptionTokenSha256,owner.revision,owner.expiresAt]);
  if(result.rows.length!==1)return null;
  return verifiedAwgMaterial(result.rows[0],owner,
    clientPublicKey,headerProtectionKey,expectedServerPublicKey,now);
}

/** Browser-only serializer: raw X25519 private key NEVER crosses the network.
 * Call from a local/handset bundle, never a server HTTP handler.
 */
export function renderLocalAwgConfig(
  material:VerifiedAwgMaterial,clientPrivateKey:string,
):string{
  if(!isCanonicalAwgPublicKey(clientPrivateKey)||
     !isCanonicalAwgPublicKey(material.clientPublicKey)||
     material.protocol!=='AmneziaWG 3.1'||material.nodeId!==NODE||
     material.endpoint!==HOST+':'+PORT||
     !IP.test(material.clientAddress.replace(/\/32$/,''))||
     !material.clientAddress.endsWith('/32')||
     !isCanonicalAwgPublicKey(material.serverPublicKey)||
     !isCanonicalAwgPublicKey(material.headerProtectionKey)||
     material.mtu!==1280)
    throw Error('Invalid reviewed FI AWG material');
  return [
    '[Interface]',
    'Address = '+material.clientAddress,
    'PrivateKey = '+clientPrivateKey,
    'MTU = 1280',
    'Jc = 0','Jmin = 0','Jmax = 0',
    'S1 = 16','S2 = 16','S3 = 16','S4 = 16',
    'H1 = 1','H2 = 2','H3 = 3','H4 = 4',
    'HeaderProtectionKey = '+material.headerProtectionKey,
    'RandomTrailers = on','DisableCookies = off',
    '',
    '[Peer]',
    'PublicKey = '+material.serverPublicKey,
    'Endpoint = '+material.endpoint,
    'AllowedIPs = 0.0.0.0/0',
    'PersistentKeepalive = 10',
    '',
  ].join('\n');
}
