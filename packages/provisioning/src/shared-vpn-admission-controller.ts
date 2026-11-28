/** Controller-side gateway core. No public listener, enrollment or data-plane hook.
 * The dedicated DB connection must use the existing restricted admission role.
 */
import type {Pool} from 'pg';
import type {KeyObject} from 'node:crypto';
import {admissionRequestSha256,verifyNodeAdmissionRequest,signControllerAdmissionDecision,
 type SignedAdmissionRequest,type SignedAdmissionDecision,type TrustedAdmissionIdentity,
 type AdmissionResult} from './shared-vpn-admission-protocol.ts';

export async function decideSharedVpnAdmission(
 db:Pick<Pool,'query'>, envelope:unknown,controllerKey:KeyObject,
 now:()=>number=Date.now,
):Promise<SignedAdmissionDecision>{
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))throw Error('Invalid admission envelope');
 const signed=envelope as SignedAdmissionRequest;
 if(typeof signed.nodeId!=='string'||!/^[a-z0-9][a-z0-9-]{2,39}$/.test(signed.nodeId))
   throw Error('Invalid admission node');
 if(controllerKey.type!=='private'||controllerKey.asymmetricKeyType!=='ed25519')throw Error('Controller key required');
 const identityResult=await db.query('SELECT public.vpn_shared_admission_node_identity($1) AS identity',[signed.nodeId]);
 const identity=identityResult.rows[0]?.identity as TrustedAdmissionIdentity|null;
 if(!identity)throw Error('Unknown admission identity');
 const request=verifyNodeAdmissionRequest(signed,identity,now());
 const digest=admissionRequestSha256(request);
 // A single autocommitted statement returns the authoritative deadline.
 const applied=await db.query('SELECT public.vpn_shared_admission_decide($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS decision',[
   request.entitlementId,request.connectionId,request.nodeId,request.peerSha256,request.op,
   request.nonce,digest,request.countryCode,identity.identityPublicSha256,request.issuedAt,
 ]);
 const row=applied.rows[0]?.decision as {result:AdmissionResult;leaseUntil:string|null}|undefined;
 if(!row||typeof row.result!=='string')throw Error('No committed admission result');
 const stamp=now();
 const positive=row.result==='ADMITTED'||row.result==='REFRESHED';
 if(positive&&(typeof row.leaseUntil!=='string'||!Number.isFinite(Date.parse(row.leaseUntil))))throw Error('Invalid ledger deadline');
 if(!positive&&row.leaseUntil!==null)throw Error('Unexpected denial lease');
 const until=positive?new Date(Date.parse(row.leaseUntil!)).toISOString():null;
 // Signing validates operation binding, exact digest, clock freshness and
 // maximum 45-second duration. On any uncertainty, do not return a grant.
 return signControllerAdmissionDecision({
   version:1,nodeId:request.nodeId,countryCode:request.countryCode,op:request.op,
   entitlementId:request.entitlementId,connectionId:request.connectionId,peerSha256:request.peerSha256,
   requestSha256:digest,result:row.result,decidedAt:new Date(stamp).toISOString(),leaseUntil:until,
 },request,controllerKey,stamp);
}
