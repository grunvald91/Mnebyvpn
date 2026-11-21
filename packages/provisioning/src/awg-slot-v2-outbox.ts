/**
 * Private AWG device-slot V2 controller outbox. This module has NO listener,
 * timer, SSH runner, public profile renderer or implicit production runner.
 * Grants are staged with an explicit root-protected Ed25519 controller key.
 * Command delivery and nodekit runtime activation require separate E2E.
 */
import {createHash,createPublicKey,verify,type KeyObject} from 'node:crypto';
import type {Pool} from 'pg';
import {
  awgSlotLeasePayload,awgSlotReceiptPayload,signAwgSlotLease,
  verifyAwgSlotReceipt,type AwgSlotLeaseV2,type AwgSlotReceiptV2,
} from './awg-device-lease-v2.ts';

type Database=Pick<Pool,'connect'>;
type Slot=1|2|3;
type Op='grant'|'revoke';
type Allocation={
  node_id:string;entitlement_id:string;slot_number:number;
  peer_public_key:string;client_ipv4:string;revision:number;
  billing_revision:string;state:string;
};
type Source={
  peer_public_key:string;client_ipv4:string;revision:string;expires_at:Date;
};
type Job={
  id:string;node_id:string;entitlement_id:string;slot_number:number;
  revision:number;billing_revision:string|null;op:Op;
  signed_command:AwgSlotLeaseV2;command_sha256:string;
  state:string;issued_at:Date;expires_delivery_at:Date;attempts:number;
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const SIG=/^[A-Za-z0-9_-]{86}$/;
const MAX_OFFLINE_MS=7*24*3600_000;

export class AwgSlotOutboxError extends Error {}
function clock(now:Date):number{
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw new AwgSlotOutboxError('Invalid trusted controller clock');
  return now.getTime();
}
function signer(key:KeyObject){
  if(key?.type!=='private'||key.asymmetricKeyType!=='ed25519')
    throw new AwgSlotOutboxError('Protected Ed25519 signing key required');
}
function slotIdentity(entitlementId:string,nodeId:string,slotNumber:number){
  if(!UUID.test(entitlementId)||nodeId!=='fi-test-01'||
     !Number.isInteger(slotNumber)||slotNumber<1||slotNumber>3)
    throw new AwgSlotOutboxError('Unapproved AWG V2 slot identity');
}
function exactPositiveRevision(value:string|number):number{
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<1||n>1_000_000_000||
     String(n)!==String(value))
    throw new AwgSlotOutboxError('Noncanonical billing revision');
  return n;
}
function sha(value:Uint8Array):string{
  return createHash('sha256').update(value).digest('hex');
}
function authenticatedCommand(job:Job,controllerKey:KeyObject):boolean{
  const cmd=job.signed_command;
  try{
    if(!cmd||typeof cmd!=='object'||Object.keys(cmd).length!==11||
       cmd.nodeId!==job.node_id||cmd.entitlementId!==job.entitlement_id||
       cmd.slotNumber!==job.slot_number||cmd.revision!==job.revision||
       cmd.op!==job.op||!SIG.test(cmd.signature)||
       !HASH.test(job.command_sha256)||
       !Number.isFinite(Date.parse(cmd.issuedAt))||
       Date.parse(cmd.issuedAt)!==job.issued_at.getTime())return false;
    const payload=awgSlotLeasePayload(cmd);
    return sha(payload)===job.command_sha256&&
      verify(null,payload,createPublicKey(controllerKey),
        Buffer.from(cmd.signature,'base64url'));
  }catch{return false;}
}

const authorizingSql=
  'SELECT c.peer_public_key,host(c.client_ipv4) AS client_ipv4,'+
  'e.revision::text AS revision,e.expires_at '+
  'FROM public.vpn_awg_ipv4_claims c '+
  'JOIN public.owner_vpn_awg_peer_reservations r '+
  'ON r.node_id=c.node_id AND r.entitlement_id=c.entitlement_id '+
  'AND r.slot_number=c.device_slot AND r.peer_public_key=c.peer_public_key '+
  'JOIN public.owner_vpn_device_seats s ON s.entitlement_id=c.entitlement_id '+
  'AND s.slot_number=c.device_slot AND s.state=\'REQUESTED\' '+
  'AND s.peer_public_key=c.peer_public_key AND s.revoked_at IS NULL '+
  'JOIN public.entitlements e ON e.id=c.entitlement_id '+
  'AND e.product=\'vpn\' AND e.state=\'ACTIVE\' '+
  'AND e.revision=r.billing_revision AND e.expires_at>$4::timestamptz '+
  'JOIN public.orders o ON o.id=e.source_order_id '+
  'AND o.account_id=e.account_id AND o.provider=\'manual_sale\' '+
  'AND o.product=\'bundle\' AND o.state=\'PAID\' '+
  'JOIN public.manual_sales m ON m.order_id=o.id '+
  'JOIN public.order_terms t ON t.order_id=o.id '+
  'AND t.plan_id=\'bundle_30d_3device\' AND t.device_limit=3 '+
  'JOIN public.provisioning_state ps ON ps.entitlement_id=e.id '+
  'AND ps.adapter=\'vpn\' AND ps.applied_revision=e.revision '+
  'AND ps.last_observed_at IS NOT NULL '+
  'JOIN public.vpn_awg_node_pools p ON p.node_id=c.node_id '+
  'AND p.state=\'verified\' AND p.endpoint_host=\'fi.mnebyvpn.site\' '+
  'AND p.subnet_cidr=cidr \'10.73.91.0/24\' '+
  'AND p.external_e2e_proof_sha256 ~ \'^[a-f0-9]{64}$\' '+
  'AND p.verified_at>$4::timestamptz-interval \'1 hour\' '+
  'AND p.verified_at<=$4::timestamptz+interval \'30 seconds\' '+
  'JOIN public.vpn_node_enrollment_inventory n ON n.node_id=p.node_id '+
  'AND n.status=\'enrolled\' AND n.endpoint_host=p.endpoint_host '+
  'WHERE c.source=\'owner_slot\' AND c.node_id=$1 '+
  'AND c.entitlement_id=$2 AND c.device_slot=$3 '+
  'AND r.billing_revision=e.revision '+
  'FOR SHARE OF c,r,s,e,o,t,ps,p,n';

async function authorizedSource(
  tx:Awaited<ReturnType<Database['connect']>>,
  nodeId:string,entitlementId:string,slotNumber:Slot,now:Date,
):Promise<Source|null>{
  const r=await tx.query<Source>(authorizingSql,
    [nodeId,entitlementId,slotNumber,now]);
  return r.rows[0]??null;
}
async function enabled(
  tx:Awaited<ReturnType<Database['connect']>>,
):Promise<boolean>{
  const r=await tx.query<{enabled:boolean}>(
    "SELECT enabled FROM public.vpn_release_flags "+
    "WHERE feature='owner_awg_slot_v2' FOR SHARE");
  return r.rows[0]?.enabled===true;
}
async function allocation(
  tx:Awaited<ReturnType<Database['connect']>>,
  nodeId:string,entitlementId:string,slotNumber:Slot,
):Promise<Allocation|null>{
  const r=await tx.query<Allocation>(
    'SELECT node_id,entitlement_id::text,slot_number,peer_public_key,'+
    'host(client_ipv4) AS client_ipv4,revision,billing_revision::text,state '+
    'FROM public.owner_vpn_awg_slot_allocations '+
    'WHERE node_id=$1 AND entitlement_id=$2 AND slot_number=$3 FOR UPDATE',
    [nodeId,entitlementId,slotNumber]);
  return r.rows[0]??null;
}

export async function stageOwnerAwgSlotGrant(
  db:Database,
  input:{operatorTelegramId:number;orderId:string;
    nodeId:'fi-test-01';slotNumber:Slot;expectedRevision:number},
  controllerKey:KeyObject,now=new Date(),
):Promise<{staged:true;published:false;command:AwgSlotLeaseV2}>{
  signer(controllerKey);clock(now);
  if(!Number.isSafeInteger(input.operatorTelegramId)||
     input.operatorTelegramId<=0||!UUID.test(input.orderId)||
     !Number.isInteger(input.slotNumber)||input.slotNumber<1||
     input.slotNumber>3||input.nodeId!=='fi-test-01'||
     !Number.isSafeInteger(input.expectedRevision)||
     input.expectedRevision<0||input.expectedRevision>1_000_000_000)
    throw new AwgSlotOutboxError('Invalid owner slot staging request');
  const tx=await db.connect();
  try{
    await tx.query('BEGIN');
    // One pool lock serializes legacy and private IPAM. The SQL allocator
    // rechecks the exact private sale and holds paid order, ACK and seat locks.
    const allocated=await tx.query<{result:string}>(
      'SELECT public.owner_vpn_allocate_awg_slot_ipv4('+
      '$1::bigint,$2::uuid,$3::smallint,$4::text) AS result',
      [input.operatorTelegramId,input.orderId,input.slotNumber,input.nodeId]);
    if(!['ALLOCATED','ALREADY_ALLOCATED'].includes(allocated.rows[0]?.result))
      throw new AwgSlotOutboxError(
        'Owner IP authorization rejected: '+allocated.rows[0]?.result);
    const ent=await tx.query<{id:string}>(
      "SELECT e.id::text FROM public.entitlements e "+
      "WHERE e.source_order_id=$1 AND e.product='vpn'",
      [input.orderId]);
    const entitlementId=ent.rows[0]?.id;
    if(!entitlementId)throw new AwgSlotOutboxError('No authorized VPN entitlement');
    slotIdentity(entitlementId,input.nodeId,input.slotNumber);

    const source=await authorizedSource(tx,input.nodeId,entitlementId,
      input.slotNumber,now);
    if(!source||!await enabled(tx))
      throw new AwgSlotOutboxError('V2 release or current manual sale not approved');
    const old=await allocation(tx,input.nodeId,entitlementId,input.slotNumber);
    const actualRevision=old?.revision??0;
    if(actualRevision!==input.expectedRevision||old?.state==='revoked')
      throw new AwgSlotOutboxError('Stale or revoked V2 device seat');
    if(old&&
       (old.peer_public_key!==source.peer_public_key||
        old.client_ipv4!==source.client_ipv4))
      throw new AwgSlotOutboxError('Unauthorized V2 key/IP rotation');
    const revision=actualRevision+1;
    if(revision>1_000_000_000)throw new AwgSlotOutboxError('V2 revision exhausted');
    const expiry=new Date(Math.min(source.expires_at.getTime(),
      now.getTime()+MAX_OFFLINE_MS));
    if(expiry.getTime()<=now.getTime())
      throw new AwgSlotOutboxError('Paid V2 lease already expired');
    const billing=exactPositiveRevision(source.revision);
    const cmd=signAwgSlotLease({
      nodeId:input.nodeId,op:'grant',entitlementId,
      slotNumber:input.slotNumber,revision,
      peerPublicKey:source.peer_public_key,
      clientIpv4:source.client_ipv4,expiresAt:expiry.toISOString(),
    },controllerKey,now);
    const digest=sha(awgSlotLeasePayload(cmd));
    if(old){
      await tx.query(
        "UPDATE public.owner_vpn_awg_slot_allocations "+
        "SET revision=$4,billing_revision=$5,expires_at=$6,state='staged',"+
        "last_command_sha256=$7,last_signed_at=$8,applied_at=NULL "+
        'WHERE node_id=$1 AND entitlement_id=$2 AND slot_number=$3',
        [input.nodeId,entitlementId,input.slotNumber,revision,billing,
         expiry,digest,now]);
    }else{
      await tx.query(
        'INSERT INTO public.owner_vpn_awg_slot_allocations '+
        '(node_id,entitlement_id,slot_number,peer_public_key,client_ipv4,'+
        'revision,billing_revision,expires_at,state,last_command_sha256,last_signed_at) '+
        "VALUES($1,$2,$3,$4,$5::inet,$6,$7,$8,'staged',$9,$10)",
        [input.nodeId,entitlementId,input.slotNumber,source.peer_public_key,
         source.client_ipv4,revision,billing,expiry,digest,now]);
    }
    await tx.query(
      'INSERT INTO public.owner_vpn_awg_slot_command_outbox '+
      '(node_id,entitlement_id,slot_number,revision,billing_revision,op,'+
      'signed_command,command_sha256,issued_at,expires_delivery_at) '+
      "VALUES($1,$2,$3,$4,$5,'grant',$6::jsonb,$7,$8,$9)",
      [input.nodeId,entitlementId,input.slotNumber,revision,billing,
       JSON.stringify(cmd),digest,now,new Date(now.getTime()+40_000)]);
    await tx.query('COMMIT');
    return {staged:true,published:false,command:cmd};
  }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
}

/** Revoke is possible even after refund/expiry or global release disable.
 * Only a trusted offline controller with its protected signing key invokes it.
 */
export async function stageOwnerAwgSlotRevoke(
  db:Database,
  input:{nodeId:'fi-test-01';entitlementId:string;
    slotNumber:Slot;expectedRevision:number},
  controllerKey:KeyObject,now=new Date(),
):Promise<{staged:true;published:false;command:AwgSlotLeaseV2}>{
  signer(controllerKey);clock(now);
  slotIdentity(input.entitlementId,input.nodeId,input.slotNumber);
  if(!Number.isSafeInteger(input.expectedRevision)||
     input.expectedRevision<1||input.expectedRevision>=1_000_000_000)
    throw new AwgSlotOutboxError('Invalid revocation revision');
  const tx=await db.connect();
  try{
    await tx.query('BEGIN');
    const old=await allocation(tx,input.nodeId,input.entitlementId,input.slotNumber);
    if(!old||old.revision!==input.expectedRevision||
       old.state==='revoked')
      throw new AwgSlotOutboxError('Stale or missing V2 revocation target');
    const revision=old.revision+1;
    const cmd=signAwgSlotLease({
      nodeId:input.nodeId,op:'revoke',entitlementId:input.entitlementId,
      slotNumber:input.slotNumber,revision,peerPublicKey:old.peer_public_key,
      clientIpv4:old.client_ipv4,expiresAt:null,
    },controllerKey,now);
    const digest=sha(awgSlotLeasePayload(cmd));
    await tx.query(
      "UPDATE public.owner_vpn_awg_slot_allocations "+
      "SET revision=$4,expires_at=NULL,state='revoked',"+
      "last_command_sha256=$5,last_signed_at=$6,applied_at=NULL "+
      'WHERE node_id=$1 AND entitlement_id=$2 AND slot_number=$3',
      [input.nodeId,input.entitlementId,input.slotNumber,revision,digest,now]);
    await tx.query(
      'INSERT INTO public.owner_vpn_awg_slot_command_outbox '+
      '(node_id,entitlement_id,slot_number,revision,billing_revision,op,'+
      'signed_command,command_sha256,issued_at,expires_delivery_at) '+
      "VALUES($1,$2,$3,$4,NULL,'revoke',$5::jsonb,$6,$7,$8)",
      [input.nodeId,input.entitlementId,input.slotNumber,revision,
       JSON.stringify(cmd),digest,now,new Date(now.getTime()+40_000)]);
    await tx.query('COMMIT');
    return {staged:true,published:false,command:cmd};
  }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
}

/** Claim only a still-current signed V2 command. NO transport in this call. */
export async function claimOwnerAwgSlotCommand(
  db:Database,controllerKey:KeyObject,now=new Date(),
):Promise<{outboxId:string;command:AwgSlotLeaseV2}|null>{
  signer(controllerKey);clock(now);
  const tx=await db.connect();
  try{
    await tx.query('BEGIN');
    await tx.query(
      "UPDATE public.owner_vpn_awg_slot_command_outbox SET state='stale' "+
      "WHERE state IN ('queued','claimed') AND expires_delivery_at<=$1",
      [now]);
    const fetched=await tx.query<Job>(
      'SELECT id::text,node_id,entitlement_id::text,slot_number,revision,'+
      'billing_revision::text,op,signed_command,command_sha256,state,'+
      'issued_at,expires_delivery_at,attempts '+
      'FROM public.owner_vpn_awg_slot_command_outbox '+
      "WHERE state IN ('queued','claimed') AND expires_delivery_at>$1 "+
      "AND issued_at>=$2 AND (state='queued' OR claimed_at<$3) "+
      'ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED',
      [now,new Date(now.getTime()-35_000),new Date(now.getTime()-10_000)]);
    const row=fetched.rows[0];
    if(!row){await tx.query('COMMIT');return null;}
    const current=await allocation(tx,row.node_id,row.entitlement_id,
      row.slot_number as Slot);
    let allowed=!!current&&current.revision===row.revision&&
      current.peer_public_key===row.signed_command.peerPublicKey&&
      current.client_ipv4===row.signed_command.clientIpv4&&
      row.attempts<8&&authenticatedCommand(row,controllerKey);
    if(row.op==='grant'){
      const source=await authorizedSource(tx,row.node_id,row.entitlement_id,
        row.slot_number as Slot,now);
      allowed=allowed&&current!.state==='staged'&&!!source&&
        source.peer_public_key===current!.peer_public_key&&
        source.client_ipv4===current!.client_ipv4&&
        exactPositiveRevision(source.revision)===
          Number(row.billing_revision)&&await enabled(tx);
    }else{
      allowed=allowed&&current!.state==='revoked';
    }
    if(!allowed){
      await tx.query(
        "UPDATE public.owner_vpn_awg_slot_command_outbox "+
        "SET state='stale' WHERE id=$1",[row.id]);
      await tx.query('COMMIT');
      return null;
    }
    await tx.query(
      "UPDATE public.owner_vpn_awg_slot_command_outbox "+
      "SET state='claimed',claimed_at=$2,attempts=attempts+1 WHERE id=$1",
      [row.id,now]);
    await tx.query('COMMIT');
    return {outboxId:row.id,command:row.signed_command};
  }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
}

/** Only a signed node ACK and an unchanged current billing/seat state
 * may mark a V2 grant as applied. An ACK is not subscription publication.
 */
export async function acknowledgeOwnerAwgSlotCommand(
  db:Database,
  entry:{outboxId:string;receipt:AwgSlotReceiptV2},
  controllerKey:KeyObject,now=new Date(),
):Promise<{acknowledged:true;published:false}>{
  signer(controllerKey);clock(now);
  if(!/^[1-9]\d{0,18}$/.test(entry.outboxId))
    throw new AwgSlotOutboxError('Invalid V2 outbox ID');
  const tx=await db.connect();
  try{
    await tx.query('BEGIN');
    const found=await tx.query<Job>(
      'SELECT id::text,node_id,entitlement_id::text,slot_number,revision,'+
      'billing_revision::text,op,signed_command,command_sha256,state,'+
      'issued_at,expires_delivery_at,attempts '+
      'FROM public.owner_vpn_awg_slot_command_outbox WHERE id=$1 FOR UPDATE',
      [entry.outboxId]);
    const row=found.rows[0];
    if(!row||row.state!=='claimed'||!authenticatedCommand(row,controllerKey))
      throw new AwgSlotOutboxError('Unknown or unclaimed V2 signed command');
    const current=await allocation(tx,row.node_id,row.entitlement_id,
      row.slot_number as Slot);
    if(!current||current.revision!==row.revision||
       current.peer_public_key!==row.signed_command.peerPublicKey||
       current.client_ipv4!==row.signed_command.clientIpv4||
       current.state!==(row.op==='grant'?'staged':'revoked'))
      throw new AwgSlotOutboxError('Stale or displaced V2 slot ACK');
    const node=await tx.query<{identity_public_spki:string;status:string}>(
      'SELECT identity_public_spki,status FROM public.awg_worker_lock_node($1)',
      [row.node_id]);
    const n=node.rows[0];
    if(!n||n.status!=='enrolled'||typeof n.identity_public_spki!=='string')
      throw new AwgSlotOutboxError('AWG node identity no longer enrolled');
    let pub:KeyObject;
    try{
      const spki=Buffer.from(n.identity_public_spki,'base64url');
      if(spki.toString('base64url')!==n.identity_public_spki)
        throw new Error('Noncanonical node SPKI');
      pub=createPublicKey({key:spki,format:'der',type:'spki'});
    }catch{
      throw new AwgSlotOutboxError('Invalid pinned node Ed25519 SPKI');
    }
    if(!verifyAwgSlotReceipt(row.signed_command,entry.receipt,pub,now))
      throw new AwgSlotOutboxError('Invalid slot-bound node ACK signature');
    if(row.op==='grant'){
      const source=await authorizedSource(tx,row.node_id,row.entitlement_id,
        row.slot_number as Slot,now);
      if(!source||!await enabled(tx)||
         source.peer_public_key!==current.peer_public_key||
         source.client_ipv4!==current.client_ipv4||
         exactPositiveRevision(source.revision)!==Number(row.billing_revision))
        throw new AwgSlotOutboxError('Billing or verified node changed before V2 ACK');
    }
    const payload=awgSlotReceiptPayload(entry.receipt);
    await tx.query(
      "UPDATE public.owner_vpn_awg_slot_command_outbox "+
      "SET state='applied',applied_at=$2,node_receipt_sha256=$3 "+
      "WHERE id=$1 AND state='claimed'",
      [entry.outboxId,now,sha(payload)]);
    if(row.op==='grant'){
      await tx.query(
        "UPDATE public.owner_vpn_awg_slot_allocations "+
        "SET state='applied',applied_at=$4 WHERE node_id=$1 "+
        "AND entitlement_id=$2 AND slot_number=$3 AND revision=$5",
        [row.node_id,row.entitlement_id,row.slot_number,now,row.revision]);
    }else{
      await tx.query(
        "UPDATE public.owner_vpn_awg_slot_allocations "+
        "SET applied_at=$4 WHERE node_id=$1 AND entitlement_id=$2 "+
        "AND slot_number=$3 AND revision=$5",
        [row.node_id,row.entitlement_id,row.slot_number,now,row.revision]);
    }
    await tx.query('COMMIT');
    return {acknowledged:true,published:false};
  }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
}
