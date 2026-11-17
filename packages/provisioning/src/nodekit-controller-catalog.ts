/**
 * Controller-only writer for additional verified REALITY nodes.
 *
 * It consumes a separately signed, entitlement-bound receipt, checks live
 * billing + enrolled node identity in one PostgreSQL transaction, and stages
 * it as 'verified' (NOT published). A separate approved promotion is required.
 * Never call from the website, bot, or an LLM agent.
 */
import type {KeyObject} from 'node:crypto';
import type {Pool} from 'pg';
import {
  additionalNodeVerificationKey,
  verifiedAdditionalVpnLinks,
  type AdditionalNodeReceipt,
} from './multi-node-subscriptions.js';

export class NodeCatalogError extends Error {}

type Writer = Pick<Pool,'connect'>;
type EntitlementRow = {
  id:string;product:string;state:string;revision:number;
  expires_at:Date|null;
};
type EnrollmentRow = {
  endpoint_host:string;status:string;identity_public_spki:string;
};
type ExistingNode = {state:string;endpoint_host:string};

function validTime(date:Date):boolean {
  return date instanceof Date&&Number.isFinite(date.getTime());
}

/**
 * Verifies existing controller Ed25519 signature on VLESS receipt and stages
 * the node as verified. It does not enable vpn_additional_nodes nor flags.
 */
export async function stageSignedNodeReceipt(
  pool:Writer,
  receipt:AdditionalNodeReceipt,
  controllerKey:KeyObject,
  now=new Date(),
):Promise<{nodeId:string;staged:boolean;published:false}> {
  if(!validTime(now)||controllerKey?.asymmetricKeyType!=='ed25519'||
     controllerKey.type!=='public')
    throw new NodeCatalogError('Trusted public controller verification key required');
  if(!receipt||!receipt.node_id||!receipt.entitlement_id)
    throw new NodeCatalogError('Receipt identity missing');

  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const entitlement=await client.query<EntitlementRow>(
      'SELECT id::text,product,state,revision,expires_at FROM entitlements '+
      'WHERE id=$1 FOR UPDATE',[receipt.entitlement_id]);
    const owner=entitlement.rows[0];
    if(!owner||owner.product!=='vpn'||owner.state!=='ACTIVE'||
       !Number.isSafeInteger(owner.revision)||owner.revision<1||
       !validTime(owner.expires_at as Date)||owner.expires_at!.getTime()<=now.getTime())
      throw new NodeCatalogError('No current ACTIVE VPN entitlement');

    const enrolled=await client.query<EnrollmentRow>(
      'SELECT endpoint_host,status,identity_public_spki '+
      'FROM vpn_node_enrollment_inventory WHERE node_id=$1 FOR UPDATE',
      [receipt.node_id]);
    const inventory=enrolled.rows[0];
    if(!inventory||inventory.status!=='enrolled'||
       inventory.endpoint_host!==receipt.endpoint_host||
       !/^[A-Za-z0-9_-]{59}$/.test(inventory.identity_public_spki))
      throw new NodeCatalogError('Unenrolled node or changed host');

    // Website already has this exact parser and signature verifier.
    const links=verifiedAdditionalVpnLinks(
      [receipt],
      {entitlementId:owner.id,revision:owner.revision,
       expiresAt:owner.expires_at!},
      controllerKey,now.getTime(),
    );
    if(links.length!==1)
      throw new NodeCatalogError('Expired or invalid signed VLESS receipt');

    const existing=await client.query<ExistingNode>(
      'SELECT state,endpoint_host FROM vpn_additional_nodes '+
      'WHERE node_id=$1 FOR UPDATE',[receipt.node_id]);
    const row=existing.rows[0];
    if(row&&(row.state!=='verified'||row.endpoint_host!==receipt.endpoint_host))
      throw new NodeCatalogError('Already active, changed or quarantined node');

    if(!row) {
      await client.query(
        'INSERT INTO vpn_additional_nodes '+
        '(node_id,country_code,country_name_ru,endpoint_host,endpoint_port,'+
        'state,exit_country_proof_sha256,vpn_e2e_proof_sha256,verified_at) '+
        "VALUES ($1,$2,$3,$4,$5,'verified',$6,$7,$8)",
        [receipt.node_id,receipt.country_code,receipt.country_name_ru,
         receipt.endpoint_host,receipt.endpoint_port,
         receipt.exit_country_proof_sha256,receipt.vpn_e2e_proof_sha256,
         receipt.verified_at],
      );
    } else {
      await client.query(
        'UPDATE vpn_additional_nodes SET country_code=$2,'+
        'country_name_ru=$3,endpoint_port=$4,exit_country_proof_sha256=$5,'+
        'vpn_e2e_proof_sha256=$6,verified_at=$7 '+
        "WHERE node_id=$1 AND state='verified' AND endpoint_host=$8",
        [receipt.node_id,receipt.country_code,receipt.country_name_ru,
         receipt.endpoint_port,receipt.exit_country_proof_sha256,
         receipt.vpn_e2e_proof_sha256,receipt.verified_at,
         receipt.endpoint_host],
      );
    }

    const written=await client.query(
      'INSERT INTO vpn_additional_node_receipts '+
      '(entitlement_id,node_id,revision,expires_at,observed_at,profile_uri,signature) '+
      'VALUES($1,$2,$3,$4,$5,$6,$7) '+
      'ON CONFLICT(entitlement_id,node_id) DO UPDATE SET '+
      'revision=EXCLUDED.revision,expires_at=EXCLUDED.expires_at,'+
      'observed_at=EXCLUDED.observed_at,profile_uri=EXCLUDED.profile_uri,'+
      'signature=EXCLUDED.signature '+
      'WHERE vpn_additional_node_receipts.revision<=EXCLUDED.revision',
      [receipt.entitlement_id,receipt.node_id,receipt.revision,
       receipt.expires_at,receipt.observed_at,receipt.profile_uri,
       receipt.signature],
    );
    if(written.rowCount!==1)
      throw new NodeCatalogError('Stale access revision; no publication');
    await client.query('COMMIT');
    return {nodeId:receipt.node_id,staged:true,published:false};
  }catch(err){
    await client.query('ROLLBACK');
    throw err;
  }finally{client.release();}
}

/**
 * A verifier reports failure: stop reading the node in all subscriptions.
 * Never disables existing old, unrelated VPN nodes or paid entitlements.
 */
export async function quarantineAdditionalNode(
  pool:Writer,nodeId:string,now=new Date(),
):Promise<{quarantined:boolean}>{
  if(!/^[a-z0-9][a-z0-9-]{2,39}$/.test(nodeId)||nodeId.endsWith('-')||
     !validTime(now))
    throw new NodeCatalogError('Invalid node ID');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const result=await client.query(
      "UPDATE vpn_additional_nodes SET state='degraded' "+
      "WHERE node_id=$1 AND state IN ('verified','enabled')",
      [nodeId]);
    await client.query('COMMIT');
    return {quarantined:result.rowCount===1};
  }catch(err){
    await client.query('ROLLBACK');
    throw err;
  }finally{client.release();}
}
