import type {Pool} from 'pg';
import {makePersonalDoTIdentity} from './personal-dot-identity.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RotationResult={
  status:string;
  hostname?:string;
  revision?:number;
};

/** Requires a verified session accountId. The SQL procedure re-checks ownership
 * while holding the entitlement lock. Do not log or persist the returned URL.
 * A successful response is the ONLY time the new bearer hostname is shown.
 */
export async function rotatePersonalDotHostname(
  db:Pick<Pool,'query'>,
  accountId:string,
  entitlementId:string,
  expectedRevision:number,
):Promise<RotationResult>{
  if(!UUID.test(accountId)||!UUID.test(entitlementId)||
     !Number.isSafeInteger(expectedRevision)||expectedRevision<1)
    return{status:'DENY_INVALID'};
  const fresh=makePersonalDoTIdentity();
  const {rows}=await db.query(
    'SELECT rotate_personal_dns_credential($1,$2,$3,$4,$5) AS status',
    [accountId,entitlementId,expectedRevision,fresh.label,fresh.tokenSha256],
  );
  if(rows.length!==1||typeof rows[0].status!=='string')
    return{status:'DENY_BACKEND'};
  if(rows[0].status!=='ROTATED')return{status:rows[0].status};
  return{status:'ROTATED',hostname:fresh.hostname,revision:expectedRevision+1};
}

/** Read-only status for the authenticated owner, never reveals the bearer.
 * The caller supplies only the verified session identity, not a public UUID.
 */
export async function personalDotStatusForOwner(
  db:Pick<Pool,'query'>,accountId:string,entitlementId:string,
):Promise<Record<string,unknown>|null>{
  if(!UUID.test(accountId)||!UUID.test(entitlementId))return null;
  const {rows}=await db.query(`SELECT s.*
    FROM entitlements e
    CROSS JOIN LATERAL personal_dns_query_status(e.id) s
    WHERE e.id=$1 AND e.account_id=$2 AND e.product='smart_dns'`,
    [entitlementId,accountId]);
  return rows.length===1?rows[0] as Record<string,unknown>:null;
}
