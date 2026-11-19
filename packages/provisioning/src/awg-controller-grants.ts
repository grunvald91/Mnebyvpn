/**
 * Controller-side AWG 3.1 entitlement allocator and Ed25519 lease issuer.
 *
 * Internal-only. NEVER expose as a browser/API signing endpoint. Must run
 * behind a dedicated trusted controller with a root-protected signing key.
 * A signed lease is NOT proof that a node applied it, and never publishes a
 * VPN subscription or user profile without separate E2E + node attestation.
 */
import {createHash,sign,type KeyObject} from 'node:crypto';
import type {Pool} from 'pg';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NODE=/^[a-z0-9][a-z0-9-]{2,39}$/;
const KEY=/^[A-Za-z0-9+/]{43}=$/;
const NODE_NETWORK=/^10\.73\.(\d{1,3})\.0\/24$/;
const MAX_OFFLINE_GRANT_MS=7*24*60*60_000; // async signed local permission; no handshake callback

export class AwgControllerError extends Error {}
export interface SignedAwgLease {
  nodeId:string;
  op:'grant'|'revoke';
  entitlementId:string;
  revision:number;
  peerPublicKey:string;
  clientIpv4:string;
  expiresAt:string|null;
  issuedAt:string;
  nonce:string;
  signature:string;
}
export function awgControllerPayload(
  command:Omit<SignedAwgLease,'signature'>,
):Buffer{
  return Buffer.from(JSON.stringify([
    'MNEBYVPN_AWG_LEASE_V1',command.nodeId,command.op,
    command.entitlementId,command.revision,command.peerPublicKey,
    command.clientIpv4,command.expiresAt,command.issuedAt,command.nonce,
  ]),'utf8');
}
function validKey(value:string):boolean{
  if(typeof value!=='string'||!KEY.test(value))return false;
  const raw=Buffer.from(value,'base64');
  return raw.length===32&&raw.toString('base64')===value;
}
function approvedSubnet(s:string):string{
  if(typeof s!=='string')throw new AwgControllerError('Invalid node subnet');
  const match=NODE_NETWORK.exec(s);
  const octet=Number(match?.[1]??NaN);
  if(!match||!Number.isSafeInteger(octet)||octet>255||
    String(octet)!==match[1])throw new AwgControllerError('Invalid AWG /24');
  // Peer provisioning currently only verified on the FI staged network.
  if(s!=='10.73.91.0/24')
    throw new AwgControllerError('Cross-country AWG IPAM not yet certified');
  return '10.73.'+octet;
}
function nextClientAddress(subnet:string,used:string[]):string{
  const prefix=approvedSubnet(subnet);
  const assigned=new Set(used);
  for(let n=2;n<=254;n++){
    const address=prefix+'.'+n;
    if(!assigned.has(address))return address;
  }
  throw new AwgControllerError('AWG node address pool exhausted');
}
function assertControllerKey(key:KeyObject){
  if(key?.asymmetricKeyType!=='ed25519'||key.type!=='private')
    throw new AwgControllerError('Trusted Ed25519 private controller key required');
}
function assertNow(date:Date){
  if(!(date instanceof Date)||!Number.isFinite(date.getTime()))
    throw new AwgControllerError('Invalid trusted controller clock');
}
type Db=Pick<Pool,'connect'>;
type Entitlement={
  id:string;product:string;state:string;revision:number;expires_at:Date|null;
};
type Enrolled={
  endpoint_host:string;status:string;
};
type NodePool={
  node_id:string;endpoint_host:string;state:string;subnet_cidr:string;
  verified_at:Date|null;server_public_key:string;
};
type Allocation={
  peer_public_key:string;client_ipv4:string;revision:number;state:string;
};
function assertIdentity(nodeId:string,entitlementId:string,publicKey:string){
  if(typeof nodeId!=='string'||!NODE.test(nodeId)||nodeId.endsWith('-')||
     typeof entitlementId!=='string'||!UUID.test(entitlementId)||
     !validKey(publicKey))
    throw new AwgControllerError('Invalid trusted AWG allocation identity');
}

/** Allocate one safe, immutable peer IP and stage a short-lived command.
 * The node must separately verify the signature, start expiry watchdog and
 * ack applying the command. This DB transaction does NOT do any SSH.
 */
export async function stageAwgGrant(
  db:Db,input:{nodeId:string;entitlementId:string;peerPublicKey:string;
    expectedBillingRevision:number;
    expectedAllocationRevision?:number;
    expectedAllocationState?:'applied'|'staged'|'revoked';},key:KeyObject,now=new Date(),
):Promise<{command:SignedAwgLease;staged:true;published:false}>{
  assertIdentity(input.nodeId,input.entitlementId,input.peerPublicKey);
  assertControllerKey(key);assertNow(now);
  if(!Number.isSafeInteger(input.expectedBillingRevision)||
     input.expectedBillingRevision<1)
    throw new AwgControllerError('Expected active billing revision is required');
  const tx=await db.connect();
  try{
    await tx.query('BEGIN');
    const e=await tx.query<Entitlement>(
      'SELECT id::text,product,state,revision,expires_at '+
      'FROM public.awg_worker_lock_entitlement($1::uuid)',[input.entitlementId]);
    const ent=e.rows[0];
    if(!ent||ent.id!==input.entitlementId||ent.product!=='vpn'||
       ent.state!=='ACTIVE'||ent.revision!==input.expectedBillingRevision||
       !(ent.expires_at instanceof Date)||
       ent.expires_at.getTime()<=now.getTime())
      throw new AwgControllerError('Billing entitlement not active/current');

    const enrollment=await tx.query<Enrolled>(
      'SELECT endpoint_host,status FROM public.awg_worker_lock_node($1)',[input.nodeId]);
    const item=enrollment.rows[0];
    const pools=await tx.query<NodePool>(
      'SELECT node_id,endpoint_host,state,subnet_cidr,verified_at,'+
      'server_public_key FROM public.awg_worker_lock_pool($1)',
      [input.nodeId]);
    const pool=pools.rows[0];
    if(!item||item.status!=='enrolled'||!pool||
       pool.node_id!==input.nodeId||pool.state!=='verified'||
       item.endpoint_host!==pool.endpoint_host||
       !/^[a-z]{2}\.mnebyvpn\.site$/.test(pool.endpoint_host)||
       !validKey(pool.server_public_key)||
       !(pool.verified_at instanceof Date)||
       now.getTime()-pool.verified_at.getTime()>60*60*1000||
       pool.verified_at.getTime()>now.getTime()+30000)
      throw new AwgControllerError('Node not recently verified or enrolled');
    const prefix=approvedSubnet(pool.subnet_cidr);
    if(pool.endpoint_host!=='fi.mnebyvpn.site')
      throw new AwgControllerError('Client AWG subnet mapping not yet verified');

    const flag=await tx.query<{enabled:boolean}>(
      "SELECT enabled FROM vpn_release_flags WHERE feature='vpn_awg_clients'");
    if(flag.rows[0]?.enabled!==true)
      throw new AwgControllerError('AWG client release is not enabled');

    const existing=await tx.query<Allocation>(
      'SELECT peer_public_key,host(client_ipv4) AS client_ipv4,revision,state '+
      'FROM vpn_awg_peer_allocations WHERE node_id=$1 AND entitlement_id=$2 FOR UPDATE',
      [input.nodeId,input.entitlementId]);
    const old=existing.rows[0];
    if(input.expectedAllocationState!==undefined &&
       (old?.state!==input.expectedAllocationState||
        old.revision!==input.expectedAllocationRevision))
      throw new AwgControllerError('Stale offline renewal candidate');
    if(old&&old.peer_public_key!==input.peerPublicKey)
      throw new AwgControllerError('Key rotation requires separate approval');
    const used=await tx.query<{client_ipv4:string}>(
      'SELECT host(client_ipv4) AS client_ipv4 FROM vpn_awg_peer_allocations '+
      'WHERE node_id=$1 FOR UPDATE',[input.nodeId]);
    const ip=old?.client_ipv4??nextClientAddress(
      pool.subnet_cidr,used.rows.map(row=>row.client_ipv4));
    if(!ip.startsWith(prefix+'.'))
      throw new AwgControllerError('Allocated address escapes subnet');
    const revision=(old?.revision??0)+1;
    if(!Number.isSafeInteger(revision)||revision>1_000_000_000)
      throw new AwgControllerError('AWG grant revision exhausted');
    const end=new Date(Math.min(
      ent.expires_at.getTime(),now.getTime()+MAX_OFFLINE_GRANT_MS));
    if(end.getTime()<=now.getTime())
      throw new AwgControllerError('No remaining entitlement lease');
    const {randomBytes}=await import('node:crypto');
    const command:Omit<SignedAwgLease,'signature'>={
      nodeId:input.nodeId,op:'grant',entitlementId:input.entitlementId,
      revision,peerPublicKey:input.peerPublicKey,clientIpv4:ip,
      expiresAt:end.toISOString(),issuedAt:now.toISOString(),
      nonce:randomBytes(32).toString('hex'),
    };
    const signature=sign(null,awgControllerPayload(command),key).toString('base64url');
    const signed={...command,signature};
    const digest=createHash('sha256').update(awgControllerPayload(command)).digest('hex');

    if(old){
      await tx.query(
        'UPDATE vpn_awg_peer_allocations SET revision=$3,expires_at=$4,'+
        "state='staged',last_signed_at=$5,last_command_sha256=$6,applied_at=NULL "+
        'WHERE node_id=$1 AND entitlement_id=$2',
        [input.nodeId,input.entitlementId,revision,end,now,digest],
      );
    }else{
      await tx.query(
        'INSERT INTO vpn_awg_peer_allocations '+
        '(node_id,entitlement_id,peer_public_key,client_ipv4,revision,'+
        'expires_at,state,last_signed_at,last_command_sha256) '+
        "VALUES ($1,$2,$3,$4::inet,$5,$6,'staged',$7,$8)",
        [input.nodeId,input.entitlementId,input.peerPublicKey,ip,
         revision,end,now,digest],
      );
    }
    // A returned signed command is NOT delivery. Persist it atomically
    // with allocation state, then let a trusted delivery worker claim it
    // while the controller timestamp is still valid.
    await tx.query(
      'INSERT INTO vpn_awg_command_outbox '+
      '(node_id,entitlement_id,revision,billing_revision,op,'+
      'signed_command,command_sha256,issued_at,expires_delivery_at) '+
      "VALUES($1,$2,$3,$4,'grant',$5::jsonb,$6,$7,$8)",
      [input.nodeId,input.entitlementId,revision,ent.revision,
       JSON.stringify(signed),digest,now,new Date(now.getTime()+40_000)],
    );
    await tx.query('COMMIT');
    return {command:signed,staged:true,published:false};
  }catch(e){
    await tx.query('ROLLBACK');
    throw e;
  }finally{tx.release();}
}

/** Revoke even if billing already expired; never allow a stale controller
 * delivery to reactivate an old revision on Nodekit.
 */
export async function stageAwgRevoke(
  db:Db,input:{nodeId:string;entitlementId:string;
    expectedAllocationRevision?:number;
    expectedAllocationState?:'applied'|'staged'|'revoked';},
  key:KeyObject,now=new Date(),
):Promise<{command:SignedAwgLease;staged:true;published:false}>{
  if(!NODE.test(input.nodeId)||!UUID.test(input.entitlementId))
    throw new AwgControllerError('Invalid revocation target');
  assertControllerKey(key);assertNow(now);
  const tx=await db.connect();
  try{
    await tx.query('BEGIN');
    const found=await tx.query<Allocation>(
      'SELECT peer_public_key,host(client_ipv4) AS client_ipv4,revision,state '+
      'FROM vpn_awg_peer_allocations WHERE node_id=$1 AND entitlement_id=$2 FOR UPDATE',
      [input.nodeId,input.entitlementId]);
    const old=found.rows[0];
    if(input.expectedAllocationState!==undefined &&
       (old?.state!==input.expectedAllocationState||
        old.revision!==input.expectedAllocationRevision))
      throw new AwgControllerError('Stale offline revocation candidate');
    if(!old||!validKey(old.peer_public_key)||
       !/^10\.73\.91\.(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(old.client_ipv4))
      throw new AwgControllerError('No revocable AWG allocation');
    const revision=old.revision+1;
    if(!Number.isSafeInteger(revision)||revision>1_000_000_000)
      throw new AwgControllerError('Revocation revision exhausted');
    const {randomBytes}=await import('node:crypto');
    const command:Omit<SignedAwgLease,'signature'>={
      nodeId:input.nodeId,op:'revoke',entitlementId:input.entitlementId,
      revision,peerPublicKey:old.peer_public_key,clientIpv4:old.client_ipv4,
      expiresAt:null,issuedAt:now.toISOString(),nonce:randomBytes(32).toString('hex'),
    };
    const signed={...command,
      signature:sign(null,awgControllerPayload(command),key).toString('base64url')};
    await tx.query(
      'UPDATE vpn_awg_peer_allocations SET revision=$3,expires_at=NULL,'+
      "state='revoked',last_signed_at=$4,last_command_sha256=$5,applied_at=NULL "+
      'WHERE node_id=$1 AND entitlement_id=$2',
      [input.nodeId,input.entitlementId,revision,now,
       createHash('sha256').update(awgControllerPayload(command)).digest('hex')],
    );
    await tx.query(
      'INSERT INTO vpn_awg_command_outbox '+
      '(node_id,entitlement_id,revision,billing_revision,op,'+
      'signed_command,command_sha256,issued_at,expires_delivery_at) '+
      "VALUES($1,$2,$3,NULL,'revoke',$4::jsonb,$5,$6,$7)",
      [input.nodeId,input.entitlementId,revision,
       JSON.stringify(signed),
       createHash('sha256').update(awgControllerPayload(command)).digest('hex'),
       now,new Date(now.getTime()+40_000)],
    );
    await tx.query('COMMIT');
    return {command:signed,staged:true,published:false};
  }catch(e){
    await tx.query('ROLLBACK');throw e;
  }finally{tx.release();}
}
