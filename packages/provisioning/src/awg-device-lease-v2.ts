/**
 * Pure offline contract for independently signed per-device AWG grants (V2).
 *
 * This is NOT a provisioning worker and does not read billing or contact
 * Nodekit. The future restricted controller MUST verify the owner, ACTIVE
 * entitlement, slot, live revision and shared IPv4 claim before signing.
 * V1 is intentionally not modified: old signed leases cannot be replayed as
 * per-slot leases. Only FI217 is certified for this draft contract.
 */
import {createHash,createPublicKey,randomBytes,sign,verify,type KeyObject}
  from 'node:crypto';

const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEY=/^[A-Za-z0-9+/]{43}=$/;
const HEX=/^[a-f0-9]{64}$/;
const SIG=/^[A-Za-z0-9_-]{86}$/;
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const MAX_LEASE_MS=7*24*3600_000;

export class AwgSlotV2Error extends Error {}
export interface AwgSlotLeaseV2 {
  nodeId:'fi-test-01';
  op:'grant'|'revoke';
  entitlementId:string;
  slotNumber:1|2|3;
  revision:number;
  peerPublicKey:string;
  clientIpv4:string;
  expiresAt:string|null;
  issuedAt:string;
  nonce:string;
  signature:string;
}
export type AwgSlotLeaseV2Draft=Omit<AwgSlotLeaseV2,
  'signature'|'issuedAt'|'nonce'> & {
  issuedAt?:string;nonce?:string;
};
export interface AwgSlotReceiptV2 {
  nodeId:string;op:'grant'|'revoke';entitlementId:string;
  slotNumber:number;revision:number;commandSha256:string;
  appliedAt:string;nonce:string;signature:string;
}

function milliseconds(value:string):number {
  if(typeof value!=='string'||!ISO.test(value))return NaN;
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)&&new Date(parsed).toISOString()===value
    ?parsed:NaN;
}
function validKey(value:string):boolean {
  if(typeof value!=='string'||!KEY.test(value))return false;
  const raw=Buffer.from(value,'base64');
  return raw.length===32&&raw.some(x=>x!==0)&&
    raw.toString('base64')===value;
}
function validIp(ip:string):boolean {
  const m=/^10\.73\.91\.(\d{1,3})$/.exec(ip??'');
  const octet=Number(m?.[1]);
  return !!m&&String(octet)===m[1]&&octet>=2&&octet<=254&&octet!==253;
}
function validDraft(d:AwgSlotLeaseV2Draft,now:number):boolean{
  const fields=['nodeId','op','entitlementId','slotNumber','revision',
    'peerPublicKey','clientIpv4','expiresAt','issuedAt','nonce'];
  if(!d||typeof d!=='object'||Object.keys(d).length!==fields.length||
     fields.some(field=>!Object.prototype.hasOwnProperty.call(d,field))||
     d.nodeId!=='fi-test-01'||
     (d.op!=='grant'&&d.op!=='revoke')||
     typeof d.entitlementId!=='string'||!ID.test(d.entitlementId)||
     !Number.isInteger(d.slotNumber)||d.slotNumber<1||d.slotNumber>3||
     !Number.isSafeInteger(d.revision)||d.revision<1||d.revision>1_000_000_000||
     !validKey(d.peerPublicKey)||!validIp(d.clientIpv4)||
     typeof d.issuedAt!=='string'||typeof d.nonce!=='string'||
     !HEX.test(d.nonce)||!Number.isFinite(milliseconds(d.issuedAt))||
     Math.abs(milliseconds(d.issuedAt)-now)>45_000)return false;
  if(d.op==='revoke')return d.expiresAt===null;
  const expiry=milliseconds(d.expiresAt??'');
  return Number.isFinite(expiry)&&expiry>now&&expiry<=now+MAX_LEASE_MS;
}

/** The same byte-exact Ed25519 payload that Nodekit V2 validates. */
export function awgSlotLeasePayload(
  d:Omit<AwgSlotLeaseV2,'signature'>,
):Buffer {
  return Buffer.from(JSON.stringify([
    'MNEBYVPN_AWG_DEVICE_LEASE_V2',d.nodeId,d.op,d.entitlementId,
    d.slotNumber,d.revision,d.peerPublicKey,d.clientIpv4,d.expiresAt,
    d.issuedAt,d.nonce,
  ]),'utf8');
}
export function awgSlotReceiptPayload(
  r:Omit<AwgSlotReceiptV2,'signature'>,
):Buffer {
  return Buffer.from(JSON.stringify([
    'MNEBYVPN_AWG_DEVICE_APPLIED_V2',r.nodeId,r.op,r.entitlementId,
    r.slotNumber,r.revision,r.commandSha256,r.appliedAt,r.nonce,
  ]),'utf8');
}

export function signAwgSlotLease(
  draft:AwgSlotLeaseV2Draft,controllerKey:KeyObject,now=new Date(),
):AwgSlotLeaseV2 {
  const timestamp=now instanceof Date?now.getTime():NaN;
  if(!Number.isFinite(timestamp)||controllerKey?.type!=='private'||
     controllerKey.asymmetricKeyType!=='ed25519')
    throw new AwgSlotV2Error('Protected Ed25519 controller identity required');
  const cmd={
    ...draft,
    issuedAt:draft.issuedAt??now.toISOString(),
    nonce:draft.nonce??randomBytes(32).toString('hex'),
  };
  if(!validDraft(cmd,timestamp))
    throw new AwgSlotV2Error('Invalid or unauthorized V2 lease shape');
  return {...cmd,signature:sign(null,awgSlotLeasePayload(cmd),controllerKey)
    .toString('base64url')};
}

/** Verify that the node signed an ACK for this EXACT slot and command.
 * This is not authorization to publish: billing+slot state MUST be rechecked.
 */
export function verifyAwgSlotReceipt(
  command:AwgSlotLeaseV2,receipt:AwgSlotReceiptV2,
  enrolledNodePublicKey:KeyObject,now=new Date(),
):boolean {
  try{
    const timestamp=now.getTime();
    if(!Number.isFinite(timestamp)||!validDraft(command,timestamp)||
       !receipt||typeof receipt!=='object'||
       Object.keys(receipt).length!==9||
       !SIG.test(receipt.signature)||
       receipt.nodeId!==command.nodeId||receipt.op!==command.op||
       receipt.entitlementId!==command.entitlementId||
       receipt.slotNumber!==command.slotNumber||
       receipt.revision!==command.revision||
       !HEX.test(receipt.commandSha256)||!HEX.test(receipt.nonce)||
       !Number.isFinite(milliseconds(receipt.appliedAt))||
       Math.abs(milliseconds(receipt.appliedAt)-timestamp)>45_000||
       enrolledNodePublicKey?.asymmetricKeyType!=='ed25519')return false;
    const digest=createHash('sha256').update(awgSlotLeasePayload(command))
      .digest('hex');
    if(digest!==receipt.commandSha256)return false;
    const payload=awgSlotReceiptPayload(receipt);
    return verify(null,payload,createPublicKey(enrolledNodePublicKey),
      Buffer.from(receipt.signature,'base64url'));
  }catch{return false;}
}
