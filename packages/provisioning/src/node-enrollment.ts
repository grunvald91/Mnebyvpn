/**
 * Operator-approved one-use Ed25519 node enrollment (controller-side only).
 *
 * Enrollment is NEVER equivalent to enabling a VPN node or publishing it in a
 * subscription. This module has no public HTTP entrypoint and no SSH access.
 * The caller must use a dedicated least-privilege database writer on a
 * trusted private control-plane host, never a browser, bot, or LLM.
 */
import {createHash,createPublicKey,randomBytes,randomUUID,sign,verify,
  type KeyObject}
  from 'node:crypto';
import type {Pool} from 'pg';

const NODE=/^[a-z0-9][a-z0-9-]{2,39}$/;
const HOST=/^[a-z0-9][a-z0-9.-]{2,251}[a-z0-9]$/;
const NONCE=/^[A-Za-z0-9_-]{43}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SIGNATURE=/^[A-Za-z0-9_-]{86}$/;
const SPKI=/^[A-Za-z0-9_-]{59}$/;
const digest=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');

export class NodeEnrollmentError extends Error {}

export interface NodeEnrollmentRequest {
  nodeId:string;
  endpointHost:string;
  publicSpki:string;
}
export interface NodeEnrollmentChallenge extends NodeEnrollmentRequest {
  challengeId:string;
  nonce:string;
  expiresAt:Date;
  controllerSignature:string;
}
export interface NodeEnrollmentProof {
  challengeId:string;
  nodeId:string;
  endpointHost:string;
  publicSpki:string;
  nonce:string;
  signature:string;
}
function validHost(s:string):boolean{
  if(!HOST.test(s)||s.includes('..')||!s.includes('.')||s==='cdn.servgo.ru')
    return false;
  const labels=s.split('.');
  return labels.length>1&&labels.every(x=>x.length>0&&x.length<=63&&
    !x.startsWith('-')&&!x.endsWith('-'))&&!s.endsWith('.local')&&
    !s.endsWith('.internal');
}
function publicKey(spki:string){
  if(!SPKI.test(spki))throw new NodeEnrollmentError('Invalid node public identity');
  try{
    const bytes=Buffer.from(spki,'base64url');
    if(bytes.length!==44||bytes.toString('base64url')!==spki)
      throw new NodeEnrollmentError('Non-canonical node public key');
    const key=createPublicKey({key:bytes,format:'der',type:'spki'});
    if(key.asymmetricKeyType!=='ed25519')
      throw new NodeEnrollmentError('Only Ed25519 enrollment is supported');
    return key;
  }catch{
    throw new NodeEnrollmentError('Invalid node public identity');
  }
}
function validNode(data:NodeEnrollmentRequest):boolean {
  return !!data&&typeof data.nodeId==='string'&&NODE.test(data.nodeId)&&
    !data.nodeId.endsWith('-')&&typeof data.endpointHost==='string'&&
    validHost(data.endpointHost)&&typeof data.publicSpki==='string';
}
export function enrollmentChallengeMessage(input:Omit<NodeEnrollmentProof,'signature'>):
  Buffer {
  return Buffer.from(JSON.stringify([
    'MNEBYVPN_NODE_ENROLL_V1',input.nodeId,input.endpointHost,
    input.publicSpki,input.challengeId,input.nonce,
  ]),'utf8');
}
export function verifyNodeEnrollmentProof(proof:NodeEnrollmentProof):boolean{
  if(!validNode(proof)||!UUID.test(proof.challengeId)||
     !NONCE.test(proof.nonce)||!SIGNATURE.test(proof.signature))return false;
  try{
    const key=publicKey(proof.publicSpki);
    const sig=Buffer.from(proof.signature,'base64url');
    return sig.length===64&&sig.toString('base64url')===proof.signature&&
      verify(null,enrollmentChallengeMessage(proof),key,sig);
  }catch{return false;}
}

/** Only controller-signed challenges may reach a new node's private key. */
export function enrollmentControllerChallengeMessage(
  challenge:Omit<NodeEnrollmentChallenge,'controllerSignature'>,
):Buffer {
  return Buffer.from(JSON.stringify([
    'MNEBYVPN_ENROLL_CHALLENGE_V1',
    challenge.nodeId,challenge.endpointHost,challenge.publicSpki,
    challenge.challengeId,challenge.nonce,challenge.expiresAt.toISOString(),
  ]),'utf8');
}

/** New challenges are minted only for identities independently approved in DB. */
export async function beginNodeEnrollment(
  pool:Pick<Pool,'connect'>,
  request:NodeEnrollmentRequest,
  controllerSigningKey:KeyObject,
):Promise<NodeEnrollmentChallenge>{
  if(!validNode(request))throw new NodeEnrollmentError('Invalid enrollment request');
  publicKey(request.publicSpki);
  if(controllerSigningKey?.asymmetricKeyType!=='ed25519')
    throw new NodeEnrollmentError('Trusted enrollment controller key is required');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const {rows}=await client.query<{
      endpoint_host:string;identity_public_spki:string;status:string;
    }>('SELECT endpoint_host,identity_public_spki,status '+
       'FROM vpn_node_enrollment_inventory WHERE node_id=$1 FOR UPDATE',
       [request.nodeId]);
    const row=rows[0];
    if(!row||row.status!=='approved'||row.endpoint_host!==request.endpointHost||
       row.identity_public_spki!==request.publicSpki)
      throw new NodeEnrollmentError('Node was not independently approved');
    const active=await client.query(
      'SELECT 1 FROM vpn_node_enrollment_challenges '+
      'WHERE node_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() LIMIT 1',
      [request.nodeId]);
    if(active.rowCount)throw new NodeEnrollmentError('Enrollment challenge already active');
    const challengeId=randomUUID(),nonce=randomBytes(32).toString('base64url');
    const inserted=await client.query<{expires_at:Date}>(
      'WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at) '+
      'INSERT INTO vpn_node_enrollment_challenges('+
      'challenge_id,node_id,nonce_sha256,issued_at,expires_at) '+
      "SELECT $1,$2,$3,at,at+interval '5 minutes' FROM stamp "+
      'RETURNING expires_at',
      [challengeId,request.nodeId,digest(nonce)]);
    const challenge={...request,challengeId,nonce,expiresAt:inserted.rows[0].expires_at};
    const controllerSignature=sign(null,enrollmentControllerChallengeMessage(challenge),
      controllerSigningKey).toString('base64url');
    await client.query('COMMIT');
    return {...challenge,controllerSignature};
  }catch(err){
    await client.query('ROLLBACK');
    throw err;
  }finally{client.release();}
}

/** Proof is consumed once inside a transaction; replay does not enroll twice. */
export async function completeNodeEnrollment(
  pool:Pick<Pool,'connect'>,
  proof:NodeEnrollmentProof,
):Promise<{nodeId:string;state:'testing'}>{
  if(!verifyNodeEnrollmentProof(proof))
    throw new NodeEnrollmentError('Invalid node possession proof');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const {rows}=await client.query<{
      node_id:string;endpoint_host:string;identity_public_spki:string;
      status:string;nonce_sha256:string;consumed_at:Date|null;valid:boolean;
    }>(
      'SELECT i.node_id,i.endpoint_host,i.identity_public_spki,i.status,'+
      'c.nonce_sha256,c.consumed_at,'+
      '(c.expires_at>clock_timestamp()) AS valid '+
      'FROM vpn_node_enrollment_challenges c '+
      'JOIN vpn_node_enrollment_inventory i ON i.node_id=c.node_id '+
      'WHERE c.challenge_id=$1 FOR UPDATE OF c,i',[proof.challengeId]);
    const row=rows[0];
    if(!row||row.consumed_at||!row.valid||row.status!=='approved'||
       row.node_id!==proof.nodeId||row.endpoint_host!==proof.endpointHost||
       row.identity_public_spki!==proof.publicSpki||
       row.nonce_sha256!==digest(proof.nonce))
      throw new NodeEnrollmentError('Unknown, expired, changed or reused challenge');
    const used=await client.query(
      'UPDATE vpn_node_enrollment_challenges '+
      'SET consumed_at=clock_timestamp() '+
      'WHERE challenge_id=$1 AND consumed_at IS NULL',[proof.challengeId]);
    if(used.rowCount!==1)throw new NodeEnrollmentError('Challenge reuse');
    const changed=await client.query(
      "UPDATE vpn_node_enrollment_inventory SET status='enrolled',"+
      'enrolled_at=clock_timestamp() '+
      "WHERE node_id=$1 AND status='approved'",[proof.nodeId]);
    if(changed.rowCount!==1)throw new NodeEnrollmentError('Node enrollment conflict');
    await client.query('COMMIT');
    return {nodeId:proof.nodeId,state:'testing'};
  }catch(err){
    await client.query('ROLLBACK');
    throw err;
  }finally{client.release();}
}
