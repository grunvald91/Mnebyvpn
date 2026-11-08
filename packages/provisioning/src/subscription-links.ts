/**
 * Opaque HTTPS VPN subscription bearer links. Only SHA-256 of the token
 * is persisted, never a VLESS credential. Every subscription fetch rechecks
 * live, node-acknowledged access in PostgreSQL.
 */
import {createHash,randomBytes} from 'node:crypto';
import type {Pool} from 'pg';
import {PgBillingStore} from '../../billing/src/store.ts';

// Use the externally tested CDN TLS/WireGuard path. Port 443 on the
// public site can time out for some networks; the HTTPS import must work.
const HOST='https://cdn.servgo.ru:8443';
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const digest=(token:string)=>createHash('sha256').update(token,'utf8').digest('hex');

export interface SubscriptionOwner {
  telegramUserId:number|null;
  entitlementId:string;
  expiresAt:Date;
}

export function subscriptionLink(token:string):string {
  if(!TOKEN.test(token))throw Error('Invalid VPN subscription token');
  return HOST+'/sub/'+token;
}
export function installerLink(token:string,client:'incy'|'karing',
  mode?:'google'):string {
  if(!TOKEN.test(token)||!['incy','karing'].includes(client)||
     (mode!==undefined&&(mode!=='google'||client!=='incy')))
    throw Error('Invalid installer link');
  return HOST+'/install/'+token+'?client='+client+
    (mode==='google'?'&mode=google':'');
}
export async function issueSubscriptionLink(pool:Pool,userId:number):Promise<{
  link:string;token:string;expiresAt:Date;entitlementId:string;
}|null>{
  const active=await new PgBillingStore(pool).confirmedVpnProfile(userId);
  if(!active)return null;
  const token=randomBytes(32).toString('base64url');
  const hash=digest(token);
  // Guard against activation/revocation races when minting a bearer token.
  const {rowCount}=await pool.query(
    "INSERT INTO vpn_subscription_links(token_sha256,entitlement_id) "+
    "SELECT $1,e.id FROM entitlements e "+
    "JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn' "+
    "JOIN accounts a ON a.id=e.account_id "+
    "WHERE e.id=$2 AND a.telegram_user_id=$3 AND e.product='vpn' "+
    "AND e.state='ACTIVE' AND e.expires_at>clock_timestamp() "+
    "AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL",
    [hash,active.entitlementId,String(userId)]);
  if(rowCount!==1)return null;
  return {link:subscriptionLink(token),token,expiresAt:active.expiresAt,
    entitlementId:active.entitlementId};
}
/** Mint a link only for the caller's authenticated internal account.
 * Re-check node-observed ACTIVE entitlement inside the private subscription DB.
 */
export async function issueSubscriptionLinkForAccount(pool:Pool,accountId:string,requestedId?:string):Promise<{
  link:string;token:string;expiresAt:Date;entitlementId:string;
}|null>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId))
    return null;
  if(requestedId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId))return null;
  const result=await pool.query(
    `SELECT e.id,e.expires_at FROM entitlements e
     JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn'
     WHERE e.account_id=$1 AND ($2::uuid IS NULL OR e.id=$2)
       AND e.product='vpn' AND e.state='ACTIVE'
       AND e.expires_at>clock_timestamp()
       AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL
     ORDER BY e.expires_at DESC LIMIT 1`,[accountId,requestedId??null]);
  if(result.rows.length!==1)return null;
  const entitlementId=String(result.rows[0].id);
  const token=randomBytes(32).toString('base64url');
  const claim=await pool.query(
    `INSERT INTO vpn_subscription_links(token_sha256,entitlement_id)
       SELECT $1,e.id FROM entitlements e
       JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn'
       WHERE e.id=$2 AND e.account_id=$3 AND e.product='vpn'
         AND e.state='ACTIVE' AND e.expires_at>clock_timestamp()
         AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL`,
    [digest(token),entitlementId,accountId]);
  return claim.rowCount===1
    ?{link:subscriptionLink(token),token,expiresAt:result.rows[0].expires_at as Date,
      entitlementId}:null;
}

export async function subscriptionOwner(pool:Pool,token:string):
  Promise<SubscriptionOwner|null>{
  if(!TOKEN.test(token))return null;
  const {rows}=await pool.query(
    "SELECT a.telegram_user_id,e.id AS entitlement_id,e.expires_at "+
    "FROM vpn_subscription_links l "+
    "JOIN entitlements e ON e.id=l.entitlement_id "+
    "JOIN accounts a ON a.id=e.account_id "+
    "JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn' "+
    "WHERE l.token_sha256=$1 AND l.revoked_at IS NULL "+
    "AND e.product='vpn' AND e.state='ACTIVE' "+
    "AND e.expires_at>clock_timestamp() "+
    "AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL "+
    "LIMIT 1",[digest(token)]);
  if(!rows.length)return null;
  const actor=Number(rows[0].telegram_user_id);
  if(rows[0].telegram_user_id!==null&&
    (!Number.isSafeInteger(actor)||actor<=0))throw Error('Invalid stored actor');
  return {telegramUserId:rows[0].telegram_user_id===null?null:actor,
    entitlementId:String(rows[0].entitlement_id),
    expiresAt:rows[0].expires_at as Date};
}
