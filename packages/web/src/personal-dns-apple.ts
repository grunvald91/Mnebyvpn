/** One-time, paid, owner-scoped Apple DNS profile delivery for the website.
 * The DoT bearer hostname is NEVER persisted or logged; only its SHA-256 is in DB.
 * A repeated download requires explicit rotation, revoking old device profiles.
 */
import type {Pool} from 'pg';
import {makePersonalDoTIdentity} from '../../dns-policy/src/personal-dot-identity.ts';
import {buildPersonalDnsMobileconfig} from '../../dns-policy/src/personal-dot-profile.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest=/^[a-f0-9]{64}$/;
export type WebsiteAppleDnsStatus={issued:boolean;revision:number|null;revoked:boolean};
export type WebsiteAppleDnsResult=
  |{kind:'ready';xml:string;hostname:string}
  |{kind:'already-issued'|'stale'|'inactive'|'revoked'|'unavailable'};

export async function websitePersonalDnsStatus(
  db:Pick<Pool,'query'>,sessionHash:string,entitlementId:string,
):Promise<WebsiteAppleDnsStatus|null>{
  if(!digest.test(sessionHash)||!uuid.test(entitlementId))return null;
  const {rows}=await db.query(
    'SELECT website_personal_dns_status($1,$2) AS status',[sessionHash,entitlementId]);
  const value:unknown=rows[0]?.status;
  if(!value||typeof value!=='object')return null;
  const result=value as {issued?:unknown;revision?:unknown;revoked?:unknown};
  const revision=result.revision===null?null:Number(result.revision);
  if(typeof result.issued!=='boolean'||typeof result.revoked!=='boolean'||
    (revision!==null&&(!Number.isSafeInteger(revision)||revision<1)))return null;
  return {issued:result.issued,revision,revoked:result.revoked};
}

/** DB functions independently verify a live website session, owner,
 * paid order, product and active entitlement in a single SQL invocation. */
export async function issueWebsitePersonalDnsProfile(
  db:Pick<Pool,'query'>,sessionHash:string,entitlementId:string,
  action:'issue'|'rotate',expectedRevision?:number,
):Promise<WebsiteAppleDnsResult>{
  if(!digest.test(sessionHash)||!uuid.test(entitlementId)||
    (action!=='issue'&&action!=='rotate')||
    (action==='rotate'&&(!Number.isSafeInteger(expectedRevision)||expectedRevision!<1)))
    return {kind:'inactive'};
  for(let attempt=0;attempt<3;attempt++){
    const identity=makePersonalDoTIdentity();
    const sql=action==='issue'
      ?'SELECT website_issue_personal_dns_credential($1,$2,$3,$4) AS code'
      :'SELECT website_rotate_personal_dns_credential($1,$2,$3,$4,$5) AS code';
    const params=action==='issue'
      ?[sessionHash,entitlementId,identity.label,identity.tokenSha256]
      :[sessionHash,entitlementId,expectedRevision,identity.label,identity.tokenSha256];
    const {rows}=await db.query(sql,params);
    const code=String(rows[0]?.code??'');
    if(code==='ISSUED'||code==='ROTATED')
      return {kind:'ready',xml:buildPersonalDnsMobileconfig(identity.hostname),hostname:identity.hostname};
    if(code==='DENY_TOKEN_COLLISION')continue;
    if(code==='DENY_ALREADY_ASSIGNED'||code==='ALREADY_ISSUED')
      return {kind:'already-issued'};
    if(code==='DENY_STALE'||code==='DENY_SAME')return {kind:'stale'};
    if(code==='DENY_REVOKED')return {kind:'revoked'};
    if(code==='DENY_OWNER'||code==='DENY_INACTIVE'||code==='DENY_UNKNOWN')
      return {kind:'inactive'};
    return {kind:'unavailable'};
  }
  return {kind:'unavailable'};
}
