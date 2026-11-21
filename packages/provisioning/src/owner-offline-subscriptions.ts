/** Idempotent VPN bearer for owner-attested in-person sales.
 * The private 32-byte key is domain-separated from personal DNS encryption.
 * Public DB stores only SHA-256(token), never the bearer itself.
 */
import {createHash,createHmac} from 'node:crypto';
import type {Pool} from 'pg';
import {subscriptionLink} from './subscription-links.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function issueOwnerOfflineSubscriptionLink(
  pool:Pick<Pool,'query'>, operatorId:number, orderId:string,
  entitlementId:string, ownerKey:Buffer,
):Promise<{link:string;expiresAt:Date;entitlementId:string}|null>{
  if(!Number.isSafeInteger(operatorId)||operatorId<=0||
     !UUID.test(orderId)||!UUID.test(entitlementId)||
     !Buffer.isBuffer(ownerKey)||ownerKey.length!==32)return null;

  const token=createHmac('sha256',ownerKey)
    .update('MNEBYVPN:offline-vpn-subscription:v1\0','utf8')
    .update(String(operatorId),'ascii').update('\0')
    .update(orderId.toLowerCase(),'ascii').update('\0')
    .update(entitlementId.toLowerCase(),'ascii')
    .digest('base64url');
  const tokenHash=createHash('sha256').update(token,'utf8').digest('hex');

  // Two independent DB statements allow a concurrent revocation or expiry
  // to suppress the link even after INSERT. Repeated calls don't add rows.
  await pool.query(
    'INSERT INTO vpn_subscription_links(token_sha256,entitlement_id) '+
    'SELECT $4,e.id FROM manual_sales m '+
    'JOIN orders o ON o.id=m.order_id AND o.provider=$5 AND o.state=$6 '+
    'JOIN entitlements e ON e.source_order_id=o.id AND e.account_id=o.account_id '+
    'JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter=$7 '+
    'WHERE m.order_id=$1 AND m.operator_telegram_id=$2 AND e.id=$3 '+
    'AND e.product=$7 AND e.state=$8 AND e.expires_at>clock_timestamp() '+
    'AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL '+
    'ON CONFLICT(token_sha256) DO NOTHING',
    [orderId,String(operatorId),entitlementId,tokenHash,
     'manual_sale','PAID','vpn','ACTIVE']);
  const result=await pool.query(
    'SELECT e.id,e.expires_at FROM manual_sales m '+
    'JOIN orders o ON o.id=m.order_id AND o.provider=$5 AND o.state=$6 '+
    'JOIN entitlements e ON e.source_order_id=o.id AND e.account_id=o.account_id '+
    'JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter=$7 '+
    'JOIN vpn_subscription_links l ON l.entitlement_id=e.id '+
    'WHERE m.order_id=$1 AND m.operator_telegram_id=$2 AND e.id=$3 '+
    'AND e.product=$7 AND e.state=$8 AND e.expires_at>clock_timestamp() '+
    'AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL '+
    'AND l.token_sha256=$4 AND l.revoked_at IS NULL LIMIT 1',
    [orderId,String(operatorId),entitlementId,tokenHash,
     'manual_sale','PAID','vpn','ACTIVE']);
  if(result.rows.length!==1)return null;
  return {link:subscriptionLink(token),
    expiresAt:result.rows[0].expires_at as Date,
    entitlementId:String(result.rows[0].id)};
}
