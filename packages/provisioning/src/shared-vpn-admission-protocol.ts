/**
 * MNEBYVPN shared DE+FI VPN admission wire ABI, V1.
 *
 * Trust boundary: a genuine node Ed25519 signature proves *who asked*, not
 * whether the peer is registered nor whether the transport blocked the peer.
 * The controller must still check the paid entitlement, signed node grant,
 * durable nonce uniqueness and atomic global cap BEFORE responding.
 *
 * This module has no side effects and never changes live client access.
 */
import {createHash,createPublicKey,sign,verify,type KeyObject} from 'node:crypto';

export type AdmissionCountry='DE'|'FI';
export type AdmissionOperation='claim'|'refresh'|'release';
export type AdmissionResult=
 'ADMITTED'|'REFRESHED'|'RELEASED'|'ALREADY_RELEASED'|
 'DENY_INVALID'|'DENY_DISABLED'|'DENY_NODE'|'DENY_UNKNOWN'|
 'DENY_ENTITLEMENT'|'DENY_LIMIT'|'DENY_REPLAY'|'DENY_BINDING';

export type AdmissionRequest={
 version:1; nodeId:string;countryCode:AdmissionCountry;
 op:AdmissionOperation;entitlementId:string;connectionId:string;
 peerSha256:string;issuedAt:string;nonce:string;
};
export type SignedAdmissionRequest=AdmissionRequest&{signature:string};
export type TrustedAdmissionIdentity={
 nodeId:string;countryCode:AdmissionCountry;
 identityPublicSpki:string;identityPublicSha256:string;
};
export type AdmissionDecision={
 version:1;nodeId:string;countryCode:AdmissionCountry;
 op:AdmissionOperation;entitlementId:string;connectionId:string;
 peerSha256:string;requestSha256:string;result:AdmissionResult;
 decidedAt:string;leaseUntil:string|null;
};
export type SignedAdmissionDecision=AdmissionDecision&{signature:string};
export type ControllerAdmissionIdentity={
 identityPublicSpki:string;identityPublicSha256:string;
};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NODE=/^[a-z0-9][a-z0-9-]{2,39}$/;
const HEX=/^[a-f0-9]{64}$/;
const SIG=/^[A-Za-z0-9_-]{86}$/;
const PUB=/^[A-Za-z0-9_-]{59}$/;
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const SPKI=Buffer.from('302a300506032b6570032100','hex');
const REQ_KEYS=['version','nodeId','countryCode','op','entitlementId',
 'connectionId','peerSha256','issuedAt','nonce'] as const;
const DEC_KEYS=['version','nodeId','countryCode','op','entitlementId',
 'connectionId','peerSha256','requestSha256','result','decidedAt',
 'leaseUntil'] as const;
const MAX_SKEW_MS=15_000;
const MAX_LEASE_MS=45_000;

export class AdmissionProtocolError extends Error{}

function exactKeys(v:unknown,keys:readonly string[]):v is Record<string,unknown>{
 return v!==null&&typeof v==='object'&&!Array.isArray(v)&&
   Object.keys(v).length===keys.length&&
   keys.every(key=>Object.prototype.hasOwnProperty.call(v,key));
}
function isoMs(s:unknown):number{
 if(typeof s!=='string'||!ISO.test(s))throw new AdmissionProtocolError('Invalid canonical UTC time');
 const n=Date.parse(s);
 if(!Number.isFinite(n)||new Date(n).toISOString()!==s)
   throw new AdmissionProtocolError('Invalid UTC instant');
 return n;
}
function verifiedKey(spki:string,pin:string):KeyObject{
 if(typeof spki!=='string'||!PUB.test(spki)||!HEX.test(pin))
   throw new AdmissionProtocolError('Missing approved Ed25519 key pin');
 const raw=Buffer.from(spki,'base64url');
 if(raw.length!==44||raw.toString('base64url')!==spki||
    !raw.subarray(0,SPKI.length).equals(SPKI))
   throw new AdmissionProtocolError('Invalid canonical Ed25519 key');
 if(createHash('sha256').update(raw).digest('hex')!==pin)
   throw new AdmissionProtocolError('Ed25519 key fingerprint mismatch');
 const key=createPublicKey({key:raw,format:'der',type:'spki'});
 if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')
   throw new AdmissionProtocolError('Expected pinned Ed25519 public key');
 return key;
}
function sigBytes(raw:string):Buffer{
 if(typeof raw!=='string'||!SIG.test(raw))
   throw new AdmissionProtocolError('Invalid Ed25519 signature');
 const buf=Buffer.from(raw,'base64url');
 if(buf.length!==64||buf.toString('base64url')!==raw)
   throw new AdmissionProtocolError('Noncanonical Ed25519 signature');
 return buf;
}
function validateRequest(v:unknown,nowMs:number):AdmissionRequest{
 if(!exactKeys(v,REQ_KEYS)||v.version!==1||
    typeof v.nodeId!=='string'||!NODE.test(v.nodeId)||
    v.nodeId.endsWith('-')||
    (v.countryCode!=='DE'&&v.countryCode!=='FI')||
    (v.op!=='claim'&&v.op!=='refresh'&&v.op!=='release')||
    typeof v.entitlementId!=='string'||!UUID.test(v.entitlementId)||
    typeof v.connectionId!=='string'||!UUID.test(v.connectionId)||
    typeof v.peerSha256!=='string'||!HEX.test(v.peerSha256)||
    /^0{64}$/.test(v.peerSha256)||
    typeof v.nonce!=='string'||!HEX.test(v.nonce)||/^0{64}$/.test(v.nonce))
   throw new AdmissionProtocolError('Invalid node admission request');
 const at=isoMs(v.issuedAt);
 if(!Number.isSafeInteger(nowMs)||Math.abs(nowMs-at)>MAX_SKEW_MS)
   throw new AdmissionProtocolError('Expired or future node request');
 return v as AdmissionRequest;
}
function requestPayload(v:AdmissionRequest):Buffer{
 return Buffer.from(JSON.stringify(['MNEBYVPN_SHARED_VPN_ADMISSION_REQUEST_V1',
  v.version,v.nodeId,v.countryCode,v.op,v.entitlementId,v.connectionId,
  v.peerSha256,v.issuedAt,v.nonce]),'utf8');
}
export function admissionRequestSha256(v:AdmissionRequest):string{
 return createHash('sha256').update(requestPayload(v)).digest('hex');
}
/** Signing is NODE-ONLY, using a node-private Ed25519 key kept off RU188. */
export function signNodeAdmissionRequest(
 req:AdmissionRequest,nodePrivateKey:KeyObject,nowMs=Date.now(),
):SignedAdmissionRequest{
 const validated=validateRequest(req,nowMs);
 if(nodePrivateKey.type!=='private'||nodePrivateKey.asymmetricKeyType!=='ed25519')
   throw new AdmissionProtocolError('Node Ed25519 signer required');
 return {...validated,
  signature:sign(null,requestPayload(validated),nodePrivateKey).toString('base64url')};
}
/** Signature check is not replay prevention; reserve nonce DURABLY before claim. */
export function verifyNodeAdmissionRequest(
 signed:SignedAdmissionRequest,node:TrustedAdmissionIdentity,nowMs=Date.now(),
):AdmissionRequest{
 if(!signed||typeof signed!=='object'||!exactKeys(signed,[...REQ_KEYS,'signature']))
   throw new AdmissionProtocolError('Unexpected node envelope fields');
 const {signature,...rest}=signed;
 const req=validateRequest(rest,nowMs);
 if(req.nodeId!==node.nodeId||req.countryCode!==node.countryCode)
   throw new AdmissionProtocolError('Admission request for wrong country/node');
 const key=verifiedKey(node.identityPublicSpki,node.identityPublicSha256);
 if(!verify(null,requestPayload(req),key,sigBytes(signature)))
   throw new AdmissionProtocolError('Untrusted node request signature');
 return req;
}
const RESULTS=new Set<AdmissionResult>([
 'ADMITTED','REFRESHED','RELEASED','ALREADY_RELEASED',
 'DENY_INVALID','DENY_DISABLED','DENY_NODE','DENY_UNKNOWN',
 'DENY_ENTITLEMENT','DENY_LIMIT','DENY_REPLAY','DENY_BINDING',
]);
function validateDecision(d:unknown,r:AdmissionRequest,nowMs:number):AdmissionDecision{
 if(!exactKeys(d,DEC_KEYS)||d.version!==1||
    d.nodeId!==r.nodeId||d.countryCode!==r.countryCode||
    d.entitlementId!==r.entitlementId||d.connectionId!==r.connectionId||
    d.op!==r.op||d.peerSha256!==r.peerSha256||
    d.requestSha256!==admissionRequestSha256(r)||
    !RESULTS.has(d.result as AdmissionResult))
   throw new AdmissionProtocolError('Decision does not bind to exact admission request');
 const at=isoMs(d.decidedAt);
 if(!Number.isSafeInteger(nowMs)||Math.abs(nowMs-at)>MAX_SKEW_MS)
   throw new AdmissionProtocolError('Stale controller decision');
 if(d.result==='ADMITTED'||d.result==='REFRESHED'){
   if(r.op==='release'||typeof d.leaseUntil!=='string')
     throw new AdmissionProtocolError('Invalid granted session operation');
   const until=isoMs(d.leaseUntil);
   if(until<=at||until>at+MAX_LEASE_MS||until<=nowMs)
     throw new AdmissionProtocolError('Controller lease not bounded');
 }else if(d.leaseUntil!==null||
    ((d.result==='RELEASED'||d.result==='ALREADY_RELEASED')&&r.op!=='release')){
   throw new AdmissionProtocolError('Denied/released access cannot carry a lease');
 }
 return d as AdmissionDecision;
}
function decisionPayload(d:AdmissionDecision):Buffer{
 return Buffer.from(JSON.stringify(['MNEBYVPN_SHARED_VPN_ADMISSION_DECISION_V1',
  d.version,d.nodeId,d.countryCode,d.op,d.entitlementId,d.connectionId,
  d.peerSha256,d.requestSha256,d.result,d.decidedAt,d.leaseUntil]),'utf8');
}
/** Signing is CONTROLLER-ONLY after verified node identity + DB atomic result. */
export function signControllerAdmissionDecision(
 decision:AdmissionDecision,request:AdmissionRequest,
 controllerPrivateKey:KeyObject,nowMs=Date.now(),
):SignedAdmissionDecision{
 const valid=validateDecision(decision,request,nowMs);
 if(controllerPrivateKey.type!=='private'||
    controllerPrivateKey.asymmetricKeyType!=='ed25519')
   throw new AdmissionProtocolError('Trusted controller Ed25519 signer required');
 return {...valid,signature:sign(null,decisionPayload(valid),controllerPrivateKey).toString('base64url')};
}
/** Nodes must reject decisions made for another request / other country. */
export function verifyControllerAdmissionDecision(
 signed:SignedAdmissionDecision,request:AdmissionRequest,
 controller:ControllerAdmissionIdentity,nowMs=Date.now(),
):AdmissionDecision{
 if(!signed||typeof signed!=='object'||!exactKeys(signed,[...DEC_KEYS,'signature']))
   throw new AdmissionProtocolError('Unexpected signed decision');
 const {signature,...body}=signed;
 const valid=validateDecision(body,request,nowMs);
 const key=verifiedKey(controller.identityPublicSpki,controller.identityPublicSha256);
 if(!verify(null,decisionPayload(valid),key,sigBytes(signature)))
   throw new AdmissionProtocolError('Untrusted controller decision signature');
 return valid;
}
