/** Telegram-owner-scoped personal DNS operations.
 *
 * The bearer label is created only in the authenticated bot process and
 * returned exactly once. PostgreSQL persists SHA256(label), never the label.
 * No Stars charge or gateway activation is performed in this module.
 * Production bot routes must remain gated until public strict DoT is verified.
 */
import type {Pool} from 'pg';
import {makePersonalDoTIdentity} from './personal-dot-identity.ts';
import {proposeRegionalPersonalDnsIdentity} from './regional-personal-dot-identity.ts';

const identity=makePersonalDoTIdentity;
const MAX_RETRIES=3;
type Access={
  entitlement_id:string;
  account_id:string;
  state:string;
  expires_at:Date|null;
  credential_revision:string|null;
  revoked_at:Date|null;
};
export type TelegramDnsSummary={
  state:string;
  expiresAt:Date|null;
  credentialIssued:boolean;
  credentialRevision:number|null;
  queryUsed:string|null;
  queryRemaining:string|null;
  queryLimit:string|null;
  accessStatus:string|null;
};
export type TelegramDnsAction=
  |{kind:'issued'|'rotated';hostname:string;credentialRevision:number}
  |{kind:'already-issued'|'not-active'|'not-issued'|'stale'|'revoked'|'unavailable'};

export async function telegramFinnishDnsRevision(db:Pick<Pool,'query'>,telegramId:number):Promise<number|null>{
  actor(telegramId);
  const {rows}=await db.query("SELECT public.telegram_regional_dns_revision($1,'FI') AS revision",[String(telegramId)]);
  const revision=rows[0]?.revision;
  if(revision===undefined||revision===null)return null;
  const value=Number(revision);
  return Number.isSafeInteger(value)&&value>=0&&value<=999_999_999?value:null;
}

export async function issueTelegramFinnishDns(
  db:Pick<Pool,'query'>,telegramId:number,expectedRevision:number,
):Promise<TelegramDnsAction>{
  actor(telegramId);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>999_999_999)
    return {kind:'stale'};
  for(let attempt=0;attempt<MAX_RETRIES;attempt++){
    const candidate=proposeRegionalPersonalDnsIdentity('FI');
    const {rows}=await db.query("SELECT public.telegram_issue_regional_dns_credential($1,'FI',$2,$3) AS result",
      [String(telegramId),candidate.label,expectedRevision]);
    const status=String(rows[0]?.result??'');
    if(status==='ISSUED'||status==='ROTATED')return {
      kind:status==='ISSUED'?'issued':'rotated',hostname:candidate.hostname,
      credentialRevision:expectedRevision+1,
    };
    if(status==='DENY_TOKEN_COLLISION')continue;
    if(status==='DENY_INACTIVE')return {kind:'not-active'};
    if(status==='DENY_REVOKED')return {kind:'revoked'};
    if(status==='DENY_STALE'||status==='ALREADY_ISSUED')return {kind:'stale'};
    return {kind:'unavailable'};
  }
  return {kind:'unavailable'};
}

function actor(id:number){
  if(!Number.isSafeInteger(id)||id<=0)throw Error('Invalid trusted Telegram actor');
}
function version(v:unknown):number{
  const result=Number(v);
  if(!Number.isSafeInteger(result)||result<1)throw Error('Bad credential revision');
  return result;
}
async function latest(db:Pool,telegramId:number):Promise<Access|null>{
  actor(telegramId);
  const {rows}=await db.query(
    `SELECT e.id::text entitlement_id,e.account_id::text account_id,
       e.state,e.expires_at,c.credential_revision,c.revoked_at
       FROM entitlements e JOIN accounts a ON a.id=e.account_id
       JOIN orders o ON o.id=e.source_order_id
       LEFT JOIN personal_dns_credentials c ON c.entitlement_id=e.id
       WHERE a.telegram_user_id=$1 AND e.product='smart_dns'
       -- A fresh paid package is a new entitlement with its own 1M quota.
       -- Prefer the newest ACTIVE purchase; do not fall back to an older,
       -- longer package whose monthly quota may already be exhausted.
       ORDER BY CASE WHEN e.state='ACTIVE' AND
         e.expires_at>clock_timestamp() THEN 0 ELSE 1 END,
         o.created_at DESC,e.expires_at DESC NULLS LAST,e.id LIMIT 1`,[String(telegramId)]);
  return rows[0]??null;
}
export async function telegramPersonalDnsSummary(
  db:Pool,telegramId:number,
):Promise<TelegramDnsSummary|null>{
  const access=await latest(db,telegramId);
  if(!access)return null;
  const base:TelegramDnsSummary={
    state:access.state,expiresAt:access.expires_at,
    credentialIssued:access.credential_revision!==null&&access.revoked_at===null,
    credentialRevision:access.credential_revision===null?null:version(access.credential_revision),
    queryUsed:null,queryRemaining:null,queryLimit:null,accessStatus:null,
  };
  if(access.credential_revision!==null){
    // Re-check owner in the SAME SQL statement that obtains usage, rather
    // than trusting an entitlement UUID supplied by a Telegram callback.
    const {rows}=await db.query(
      `SELECT s.* FROM accounts a
       JOIN entitlements e ON e.account_id=a.id
       CROSS JOIN LATERAL personal_dns_query_status(e.id) s
       WHERE a.telegram_user_id=$1 AND e.id=$2 AND e.product='smart_dns'`,
       [String(telegramId),access.entitlement_id]);
    if(rows.length){
      base.queryUsed=String(rows[0].used_queries);
      base.queryRemaining=String(rows[0].remaining_queries);
      base.queryLimit=String(rows[0].allowed_queries);
      base.accessStatus=String(rows[0].access_status);
      base.credentialRevision=version(rows[0].credential_revision);
    }
  }
  return base;
}
/** Authorized issuance. If the label was previously issued, no old bearer can
 * be recovered from its hash: the user must explicitly rotate it instead.
 */
export async function issueTelegramPersonalDns(
  db:Pool,telegramId:number,
):Promise<TelegramDnsAction>{
  const access=await latest(db,telegramId);
  if(!access||access.state!=='ACTIVE'||!access.expires_at||
     access.expires_at.getTime()<=Date.now())return {kind:'not-active'};
  if(access.revoked_at!==null)return {kind:'revoked'};
  if(access.credential_revision!==null)return {kind:'already-issued'};
  for(let i=0;i<MAX_RETRIES;i++){
    const newIdentity=identity();
    const {rows}=await db.query(
      `SELECT issue_personal_dns_credential(e.id,$3,$4,$5) AS result
         FROM entitlements e JOIN accounts a ON a.id=e.account_id
        WHERE a.telegram_user_id=$1 AND e.id=$2 AND e.product='smart_dns'`,
      [String(telegramId),access.entitlement_id,newIdentity.label,
       newIdentity.tokenSha256,newIdentity.queryLimitPer30d]);
    const status=String(rows[0]?.result??'DENY_OWNER');
    if(status==='ISSUED')return{
      kind:'issued',hostname:newIdentity.hostname,credentialRevision:1,
    };
    if(status==='DENY_TOKEN_COLLISION')continue;
    if(status==='DENY_ALREADY_ASSIGNED'||status==='ALREADY_ISSUED')
      return {kind:'already-issued'};
    if(status==='DENY_REVOKED')return {kind:'revoked'};
    if(status==='DENY_INACTIVE')return {kind:'not-active'};
    return {kind:'unavailable'};
  }
  return {kind:'unavailable'};
}
/** Expected revision comes from the one-time confirmation button and makes
 * Telegram webhook redelivery idempotent: a repeated tap cannot rotate again.
 */
export async function rotateTelegramPersonalDns(
  db:Pool,telegramId:number,expectedRevision:number,
):Promise<TelegramDnsAction>{
  actor(telegramId);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||
     expectedRevision>Number.MAX_SAFE_INTEGER)return {kind:'stale'};
  const access=await latest(db,telegramId);
  if(!access||access.state!=='ACTIVE'||!access.expires_at||
     access.expires_at.getTime()<=Date.now())return {kind:'not-active'};
  if(access.revoked_at!==null)return {kind:'revoked'};
  if(access.credential_revision===null)return {kind:'not-issued'};
  if(version(access.credential_revision)!==expectedRevision)return {kind:'stale'};
  for(let i=0;i<MAX_RETRIES;i++){
    const newIdentity=identity();
    const {rows}=await db.query(
      `SELECT rotate_personal_dns_credential(a.id,e.id,$3,$4,$5) AS result
         FROM entitlements e JOIN accounts a ON a.id=e.account_id
        WHERE a.telegram_user_id=$1 AND e.id=$2 AND e.product='smart_dns'`,
      [String(telegramId),access.entitlement_id,expectedRevision,
       newIdentity.label,newIdentity.tokenSha256]);
    const status=String(rows[0]?.result??'DENY_OWNER');
    if(status==='ROTATED')return{
      kind:'rotated',hostname:newIdentity.hostname,
      credentialRevision:expectedRevision+1,
    };
    if(status==='DENY_TOKEN_COLLISION')continue;
    if(status==='DENY_STALE'||status==='DENY_SAME')return {kind:'stale'};
    if(status==='DENY_REVOKED')return {kind:'revoked'};
    if(status==='DENY_UNKNOWN')return {kind:'not-issued'};
    if(status==='DENY_INACTIVE')return {kind:'not-active'};
    return {kind:'unavailable'};
  }
  return {kind:'unavailable'};
}

/** Explicit bundle-only callbacks never resolve against the newest paid order. */
export async function telegramBundleTrialDnsStatus(db:Pick<Pool,'query'>,id:number):
 Promise<{deRevision:number|null;fiRevision:number|null}|null>{
 actor(id);
 const {rows}=await db.query('SELECT public.telegram_bundle_trial_dns_status($1) AS status',[String(id)]);
 const s=rows[0]?.status;
 if(!s||typeof s!=='object')return null;
 const revision=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=999999999?v:null;
 return {deRevision:revision(s.deRevision),fiRevision:revision(s.fiRevision)};
}
export async function issueTelegramBundleTrialDns(db:Pick<Pool,'query'>,id:number,country:'DE'|'FI',expected:number):Promise<TelegramDnsAction>{
 actor(id);
 if(!['DE','FI'].includes(country)||!Number.isSafeInteger(expected)||expected<0||expected>999999999)return {kind:'stale'};
 for(let attempt=0;attempt<MAX_RETRIES;attempt++){
   const candidate=country==='DE'?identity():proposeRegionalPersonalDnsIdentity('FI');
   const {rows}=await db.query('SELECT public.telegram_bundle_trial_dns_issue($1,$2,$3,$4) AS result',[String(id),country,candidate.label,expected]);
   const status=String(rows[0]?.result??'');
   if(status==='ISSUED'||status==='ROTATED')return {kind:status==='ISSUED'?'issued':'rotated',hostname:candidate.hostname,credentialRevision:expected+1};
   if(status==='DENY_TOKEN_COLLISION')continue;
   if(status==='DENY_INACTIVE')return {kind:'not-active'};
   if(status==='DENY_REVOKED')return {kind:'revoked'};
   if(['DENY_ALREADY_ASSIGNED','ALREADY_ISSUED','DENY_STALE','DENY_SAME'].includes(status))return {kind:'stale'};
   return {kind:'unavailable'};
 }
 return {kind:'unavailable'};
}
