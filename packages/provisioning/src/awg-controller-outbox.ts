/**
 * Durable controller-only AWG 3.1 delivery queue.
 *
 * A signed command has a 40-second transport window. After that it is STALE,
 * not silently retried with an invalid Ed25519 timestamp. A new entitlement-
 * checked staged revision must be created. No public HTTP routes are exposed.
 */
import {createPublicKey,createHash,verify,type KeyObject} from 'node:crypto';
import type {Pool} from 'pg';
import {
  awgControllerPayload,type SignedAwgLease,
  AwgControllerError,
} from './awg-controller-grants.ts';

type Connection=Pick<Pool,'connect'>;
type Outbox={
  id:string;
  node_id:string;entitlement_id:string;revision:number;
  billing_revision:number|null;
  op:'grant'|'revoke';
  signed_command:SignedAwgLease;
  command_sha256:string;
  state:string;attempts:number;issued_at:Date;expires_delivery_at:Date;
};
export type NodeAwgReceipt={
  nodeId:string;op:'grant'|'revoke';entitlementId:string;
  revision:number;commandSha256:string;appliedAt:string;nonce:string;
  signature:string;
};
const HEX64=/^[0-9a-f]{64}$/;
const SIG=/^[a-zA-Z0-9_-]{86}$/;
const ID=/^[a-z0-9][a-z0-9-]{2,39}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class AwgDeliveryError extends Error {}

export function nodeAwgReceiptPayload(r:Omit<NodeAwgReceipt,'signature'>):Buffer {
  return Buffer.from(JSON.stringify([
    'MNEBYVPN_AWG_APPLIED_V1',r.nodeId,r.op,r.entitlementId,
    r.revision,r.commandSha256,r.appliedAt,r.nonce,
  ]),'utf8');
}
function digest(s:Uint8Array|string):string{
  return createHash('sha256').update(s).digest('hex');
}
function date(value:Date):number{
  if(!(value instanceof Date)||!Number.isFinite(value.getTime()))
    throw new AwgDeliveryError('Invalid controller clock');
  return value.getTime();
}
function validCommand(row:Outbox,key:KeyObject):boolean{
  const signed=row.signed_command;
  if(!signed||typeof signed!=='object'||
     signed.nodeId!==row.node_id||
     signed.entitlementId!==row.entitlement_id||
     signed.revision!==row.revision||signed.op!==row.op||
     !HEX64.test(row.command_sha256)||
     !SIG.test(signed.signature))return false;
  const content=awgControllerPayload(signed);
  return digest(content)===row.command_sha256&&
    verify(null,content,createPublicKey(key),
           Buffer.from(signed.signature,'base64url'));
}

/** Atomically lease one still-valid command to an authenticated worker.
 * A grant is rechecked against live billing and the FI release gate at
 * delivery time to prevent stale paid entitlements from being activated.
 */
export async function claimAwgCommand(
  pool:Connection,controllerKey:KeyObject,now=new Date(),
):Promise<{outboxId:string;command:SignedAwgLease}|null>{
  const timestamp=date(now);
  if(controllerKey?.type!=='private'||controllerKey.asymmetricKeyType!=='ed25519')
    throw new AwgDeliveryError('Private controller identity required');
  const tx=await pool.connect();
  try{
    await tx.query('BEGIN');
    await tx.query(
      "UPDATE vpn_awg_command_outbox SET state='stale' "+
      "WHERE state IN ('queued','claimed') AND expires_delivery_at<=$1",
      [now],
    );
    const q=await tx.query<Outbox>(
      'SELECT id::text,node_id,entitlement_id::text,revision,billing_revision,'+
      'op,signed_command,command_sha256,state,attempts,issued_at,expires_delivery_at '+
      'FROM vpn_awg_command_outbox WHERE state IN (\'queued\',\'claimed\') '+
      'AND expires_delivery_at>$1 AND issued_at>=$2 '+
      "AND (state='queued' OR claimed_at<$3) "+
      'ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED',
      [now,new Date(timestamp-35_000),new Date(timestamp-10_000)],
    );
    const row=q.rows[0];
    if(!row){
      await tx.query('COMMIT');
      return null;
    }
    const allocation=await tx.query<{
      revision:number;state:string;peer_public_key:string;client_ipv4:string;
    }>(
      'SELECT revision,state,peer_public_key,host(client_ipv4) AS client_ipv4 '+
      'FROM vpn_awg_peer_allocations WHERE node_id=$1 AND entitlement_id=$2 FOR UPDATE',
      [row.node_id,row.entitlement_id],
    );
    const current=allocation.rows[0];
    const cmd=row.signed_command;
    let approved=!!current&&current.revision===row.revision&&
      current.peer_public_key===cmd.peerPublicKey&&
      current.client_ipv4===cmd.clientIpv4&&validCommand(row,controllerKey)&&
      row.attempts<8;
    if(row.op==='grant'){
      const e=await tx.query<{product:string;state:string;revision:number;expires_at:Date}>(
        'SELECT product,state,revision,expires_at FROM entitlements '+
        'WHERE id=$1 FOR UPDATE',[row.entitlement_id]);
      const r=e.rows[0];
      const poolCheck=await tx.query<{
        state:string;verified_at:Date;endpoint_host:string;status:string;
      }>(
        'SELECT p.state,p.verified_at,p.endpoint_host,i.status '+
        'FROM vpn_awg_node_pools p JOIN vpn_node_enrollment_inventory i '+
        'ON i.node_id=p.node_id WHERE p.node_id=$1 FOR UPDATE',
        [row.node_id],
      );
      const node=poolCheck.rows[0];
      const release=await tx.query<{enabled:boolean}>(
        "SELECT enabled FROM vpn_release_flags WHERE feature='vpn_awg_clients'");
      approved=approved&&current!.state==='staged'&&
        !!r&&r.product==='vpn'&&r.state==='ACTIVE'&&
        r.revision===row.billing_revision&&r.expires_at instanceof Date&&
        r.expires_at.getTime()>timestamp&&
        !!node&&node.state==='verified'&&node.status==='enrolled'&&
        node.endpoint_host==='fi.mnebyvpn.site'&&
        node.verified_at instanceof Date&&
        timestamp-node.verified_at.getTime()<=3600_000&&
        node.verified_at.getTime()<=timestamp+30_000&&
        release.rows[0]?.enabled===true;
    }else{
      approved=approved&&current!.state==='revoked';
    }
    if(!approved){
      await tx.query("UPDATE vpn_awg_command_outbox SET state='stale' WHERE id=$1",
                     [row.id]);
      await tx.query('COMMIT');
      return null;
    }
    await tx.query(
      "UPDATE vpn_awg_command_outbox SET state='claimed',claimed_at=$2,"+
      'attempts=attempts+1 WHERE id=$1',[row.id,now],
    );
    await tx.query('COMMIT');
    return {outboxId:row.id,command:cmd};
  }catch(e){
    await tx.query('ROLLBACK');throw e;
  }finally{tx.release();}
}

/** Accept only an independently signed NODE receipt, never a caller-supplied
 * boolean "applied". The node's public SPKI was pinned at enrollment.
 */
export async function acknowledgeAwgCommand(
  pool:Connection,entry:{outboxId:string;receipt:NodeAwgReceipt},
  now=new Date(),
):Promise<{acknowledged:true;published:false}>{
  const timestamp=date(now);
  const {receipt:r}=entry;
  if(!/^[1-9]\d{0,18}$/.test(entry.outboxId)||
     !r||typeof r!=='object'||
     !ID.test(r.nodeId)||r.nodeId.endsWith('-')||
     !UUID.test(r.entitlementId)||!Number.isSafeInteger(r.revision)||
     !['grant','revoke'].includes(r.op)||!HEX64.test(r.commandSha256)||
     !HEX64.test(r.nonce)||!SIG.test(r.signature)||
     typeof r.appliedAt!=='string'||
     !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.appliedAt)||
     !Number.isFinite(Date.parse(r.appliedAt))||
     new Date(r.appliedAt).toISOString()!==r.appliedAt||
     Math.abs(timestamp-Date.parse(r.appliedAt))>180_000)
    throw new AwgDeliveryError('Invalid or stale signed node receipt');

  const tx=await pool.connect();
  try{
    await tx.query('BEGIN');
    const q=await tx.query<Outbox>(
      'SELECT id::text,node_id,entitlement_id::text,revision,op,'+
      'command_sha256,state FROM vpn_awg_command_outbox WHERE id=$1 FOR UPDATE',
      [entry.outboxId],
    );
    const row=q.rows[0];
    if(!row||row.state!=='claimed'||row.node_id!==r.nodeId||
       row.entitlement_id!==r.entitlementId||row.revision!==r.revision||
       row.op!==r.op||row.command_sha256!==r.commandSha256)
      throw new AwgDeliveryError('Receipt does not match claimed command');

    const n=await tx.query<{identity_public_spki:string;status:string}>(
      'SELECT identity_public_spki,status FROM vpn_node_enrollment_inventory '+
      'WHERE node_id=$1 FOR UPDATE',[r.nodeId],
    );
    const node=n.rows[0];
    if(!node||node.status!=='enrolled'||!/^[-_a-zA-Z0-9]{59}$/.test(
      node.identity_public_spki))
      throw new AwgDeliveryError('Node identity not enrolled');
    const key=createPublicKey({
      key:Buffer.from(node.identity_public_spki,'base64url'),
      format:'der',type:'spki',
    });
    if(key.asymmetricKeyType!=='ed25519'||!verify(
      null,nodeAwgReceiptPayload(r),key,Buffer.from(r.signature,'base64url')))
      throw new AwgDeliveryError('Node Ed25519 receipt signature invalid');

    const peers=await tx.query<{revision:number;state:string}>(
      'SELECT revision,state FROM vpn_awg_peer_allocations '+
      'WHERE node_id=$1 AND entitlement_id=$2 FOR UPDATE',
      [r.nodeId,r.entitlementId],
    );
    const peer=peers.rows[0];
    if(!peer||peer.revision!==r.revision||
       (r.op==='grant'&&peer.state!=='staged')||
       (r.op==='revoke'&&peer.state!=='revoked'))
      throw new AwgDeliveryError('Stale or displaced node receipt');
    if(r.op==='grant'){
      const ent=await tx.query<{state:string;product:string;expires_at:Date}>(
        'SELECT state,product,expires_at FROM entitlements WHERE id=$1 FOR UPDATE',
        [r.entitlementId],
      );
      const e=ent.rows[0];
      if(!e||e.product!=='vpn'||e.state!=='ACTIVE'||
         !(e.expires_at instanceof Date)||e.expires_at.getTime()<=timestamp)
        throw new AwgDeliveryError('Billing revoked before receipt acknowledgement');
    }
    const result=await tx.query(
      "UPDATE vpn_awg_command_outbox SET state='applied',applied_at=$2,"+
      'node_receipt_sha256=$3 WHERE id=$1 AND state=\'claimed\'',
      [entry.outboxId,now,digest(nodeAwgReceiptPayload(r))],
    );
    if(result.rowCount!==1)throw new AwgDeliveryError('Receipt race');
    await tx.query(
      r.op==='grant'?
      "UPDATE vpn_awg_peer_allocations SET state='applied',applied_at=$3 "+
      'WHERE node_id=$1 AND entitlement_id=$2 AND revision=$4':
      "UPDATE vpn_awg_peer_allocations SET applied_at=$3 "+
      'WHERE node_id=$1 AND entitlement_id=$2 AND revision=$4',
      [r.nodeId,r.entitlementId,now,r.revision],
    );
    await tx.query('COMMIT');
    return {acknowledged:true,published:false};
  }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
}
