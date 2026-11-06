/**
 * Anonymous-but-cookie-bound website VPN trials. A guest is NEVER represented
 * as a fabricated Telegram actor. The cookie is a 256-bit bearer secret; only
 * its SHA-256 digest is stored. Claims are idempotent for the same cookie.
 *
 * Browsers can delete their cookie, so this is a low-friction trial, NOT a
 * verified one-per-human anti-abuse system.
 */
import {createHash,createHmac,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {subscriptionLink} from './subscription-links.ts';

const format=/^[A-Za-z0-9_-]{43}$/;
const digest=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
const assertToken=(v:string)=>{if(!format.test(v))throw Error('Invalid guest token');};
export type GuestTrialState={
  status:'NONE'|'PENDING'|'ACTIVE'|'EXPIRED';
  expiresAt?:string;
  subscriptionUrl?:string;
};

export async function claimGuestVpnTrial(pool:Pool,claimToken:string):
  Promise<'GRANTED'|'PENDING'|'ALREADY_USED'|'UNAVAILABLE'>{
  assertToken(claimToken);
  const hash=digest(claimToken);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    // Hash only; serialized across simultaneous taps from one browser.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[hash]);
    let owner=(await c.query('SELECT account_id FROM web_guest_claims WHERE token_sha256=$1 FOR UPDATE',[hash])).rows[0];
    if(!owner){
      const account=randomUUID();
      await c.query('INSERT INTO accounts(id,telegram_user_id) VALUES($1,NULL)',[account]);
      await c.query('INSERT INTO web_guest_claims(token_sha256,account_id) VALUES($1,$2)',[hash,account]);
      owner={account_id:account};
    }
    const existing=await c.query(
      'SELECT order_id,activated_at FROM trial_grants WHERE account_id=$1 FOR UPDATE',
      [owner.account_id]);
    if(existing.rowCount){
      await c.query('COMMIT');
      return existing.rows[0].activated_at===null?'PENDING':'ALREADY_USED';
    }
    const offer=await c.query(
      "SELECT 1 FROM trial_offers WHERE product='vpn' AND enabled=true AND duration_seconds=86400");
    if(!offer.rowCount){await c.query('COMMIT');return 'UNAVAILABLE';}
    const order=randomUUID(),entitlement=randomUUID();
    await c.query(
      "INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state) "+
      "VALUES($1,$2,'vpn','internal_trial',0,'XTR','TRIAL')",
      [order,owner.account_id]);
    await c.query(
      "INSERT INTO trial_grants(account_id,order_id,product,guest_claim_hash) "+
      "VALUES($1,$2,'vpn',$3)",[owner.account_id,order,hash]);
    await c.query(
      "INSERT INTO entitlements(id,account_id,source_order_id,product,state,revision,"+
      "starts_at,expires_at,quota_limit_bytes) "+
      "VALUES($1,$2,$3,'vpn','PAID_PENDING_PROVISIONING',1,NULL,NULL,NULL)",
      [entitlement,owner.account_id,order]);
    await c.query('INSERT INTO reconcile_outbox(entitlement_id,desired_revision) VALUES($1,1)',
      [entitlement]);
    await c.query('COMMIT');
    return 'GRANTED';
  }catch(err){await c.query('ROLLBACK');throw err;}
  finally{c.release();}
}

export async function confirmedGuestEntitlement(pool:Pool,entitlementId:string):
  Promise<{entitlementId:string;revision:number;expiresAt:Date}|null>{
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(entitlementId))return null;
  const {rows}=await pool.query(
    "SELECT e.id,e.revision,e.expires_at FROM entitlements e "+
    "JOIN web_guest_claims g ON g.account_id=e.account_id "+
    "JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn' "+
    "WHERE e.id=$1 AND e.product='vpn' AND e.state='ACTIVE' "+
    "AND e.expires_at>clock_timestamp() AND p.applied_revision=e.revision "+
    "AND p.last_observed_at IS NOT NULL LIMIT 1",[entitlementId]);
  if(!rows.length)return null;
  return {entitlementId:String(rows[0].id),revision:Number(rows[0].revision),
    expiresAt:rows[0].expires_at as Date};
}

export async function guestVpnState(pool:Pool,claimToken:string,
  profileSecret:string):Promise<GuestTrialState>{
  assertToken(claimToken);
  if(!/^[a-f0-9]{64}$/i.test(profileSecret))throw Error('Invalid private worker secret');
  const {rows}=await pool.query(
    "SELECT e.id,e.state,e.expires_at,t.activated_at,e.revision,"+
    "p.applied_revision,p.last_observed_at "+
    "FROM web_guest_claims g "+
    "JOIN trial_grants t ON t.guest_claim_hash=g.token_sha256 "+
    "JOIN entitlements e ON e.source_order_id=t.order_id AND e.product='vpn' "+
    "LEFT JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn' "+
    "WHERE g.token_sha256=$1 ORDER BY e.id LIMIT 1",[digest(claimToken)]);
  if(!rows.length)return {status:'NONE'};
  const row=rows[0],expire=row.expires_at as Date|null;
  const expiry=expire instanceof Date?expire.toISOString():undefined;
  if(row.state==='ACTIVE'&&expire&&expire.getTime()>Date.now() &&
     Number(row.revision)===Number(row.applied_revision)&&row.last_observed_at){
    // Deterministic URL for this cookie; minting again is idempotent. The
    // underlying credential still expires at the node's real deadline.
    const sub=createHmac('sha256',Buffer.from(profileSecret,'hex'))
      .update('mnebyvpn-guest-sub-v1:').update(claimToken).digest('base64url');
    const result=await pool.query(
      "INSERT INTO vpn_subscription_links(token_sha256,entitlement_id) "+
      "SELECT $1,e.id FROM entitlements e "+
      "JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn' "+
      "WHERE e.id=$2 AND e.state='ACTIVE' AND e.expires_at>clock_timestamp() "+
      "AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL "+
      "ON CONFLICT (token_sha256) DO NOTHING",[digest(sub),row.id]);
    // Even on conflict, the token is deterministic and bound to the same
    // claim. Never reuse the token as an unrelated subscription.
    if(result.rowCount!==1){
      const check=await pool.query(
        "SELECT 1 FROM vpn_subscription_links WHERE token_sha256=$1 "+
        "AND entitlement_id=$2 AND revoked_at IS NULL",[digest(sub),row.id]);
      if(!check.rowCount)throw Error('Conflicting guest subscription token');
    }
    return {status:'ACTIVE',expiresAt:expiry,subscriptionUrl:subscriptionLink(sub)};
  }
  if(row.activated_at && (!expire||expire.getTime()<=Date.now()||
     ['EXPIRED','CANCELLED','REFUNDED'].includes(row.state)))
    return {status:'EXPIRED',expiresAt:expiry};
  return {status:'PENDING',expiresAt:expiry};
}
