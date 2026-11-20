/**
 * RU188-only bridge between a website-authorized X25519 PUBLIC key request
 * and the existing controller-signed, async FI217 AmneziaWG grant/outbox.
 *
 * No HTTP listener, no private client keys, no subscription publication.
 * At most one queued request per tick. The node's real signed ACK is
 * verified and persisted by the EXISTING delivery worker, not here.
 */
import type {Pool} from 'pg';
import type {KeyObject} from 'node:crypto';
import {
  stageAwgGrant,normalizeAwgBillingRevision,
} from './awg-controller-grants.ts';

const KEY=/^[A-Za-z0-9+/]{43}=$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NODE='fi-test-01';
type Db=Pick<Pool,'connect'|'query'>;
type Pending={
  entitlement_id:string;
  node_id:string;
  peer_public_key:string;
  billing_revision:string|number;
  attempts:number;
};
export type RegistrationTick=
  {status:'idle'} | {status:'staged'} | {status:'already_staged'} |
  {status:'blocked'} | {status:'retry'};

/** One short SQL transaction claims the request, then RELEASES its lock.
 * Never hold a database transaction while signing or contacting a VPS.
 */
export async function stageNextFiAwgDevice(
  db:Db,key:KeyObject,now=new Date(),
):Promise<RegistrationTick>{
  if(key?.type!=='private'||key.asymmetricKeyType!=='ed25519'||
     !(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw Error('Trusted RU188 signer and clock required');
  const tx=await db.connect();
  let row:Pending|undefined;
  try{
    await tx.query('BEGIN');
    const q=await tx.query<Pending>(
      'SELECT entitlement_id::text,node_id,peer_public_key,billing_revision,attempts '+
      'FROM vpn_awg_device_requests WHERE '+
      "(state='queued' OR (state='processing' "+
      "AND claimed_at<clock_timestamp()-interval '90 seconds')) "+
      'AND next_attempt_at<=clock_timestamp() '+
      'ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED',
    );
    row=q.rows[0];
    if(row){
      const u=await tx.query(
        "UPDATE vpn_awg_device_requests SET state='processing',"+
        "claimed_at=clock_timestamp(),updated_at=clock_timestamp(),"+
        'attempts=attempts+1 WHERE entitlement_id=$1 AND node_id=$2',
        [row.entitlement_id,NODE],
      );
      if(u.rowCount!==1)throw Error('AWG device claim conflicted');
    }
    await tx.query('COMMIT');
  }catch{
    await tx.query('ROLLBACK');
    throw Error('AWG device queue claim failed');
  }finally{tx.release();}
  if(!row)return {status:'idle'};

  const where=[row.entitlement_id,NODE,row.peer_public_key];
  // Reject wrong keys and foreign node IDs without ever asking the signer.
  let kind:'staged'|'already_staged'|'blocked'|'retry'='retry';
  try{
    const revision=normalizeAwgBillingRevision(row.billing_revision);
    if(!UUID.test(row.entitlement_id)||row.node_id!==NODE||
       !KEY.test(row.peer_public_key)||revision===null||
       !Number.isSafeInteger(row.attempts)||row.attempts<0||
       row.attempts>=100){
      kind='blocked';
    }else{
      const current=await db.query<{
        peer_public_key:string;state:string;
      }>('SELECT peer_public_key,state FROM vpn_awg_peer_allocations '+
         'WHERE node_id=$2 AND entitlement_id=$1',
        [row.entitlement_id,NODE]);
      if(current.rows.length>1 ||
         (current.rows.length===1 &&
          (current.rows[0].peer_public_key!==row.peer_public_key||
           !['staged','applied'].includes(current.rows[0].state)))){
        kind='blocked';
      }else if(current.rows.length===1){
        // Interrupted transition: signed outbox already exists. The
        // standard offline maintenance will retry expired staged grants
        // after 90 seconds; never issue a duplicate from this worker.
        kind='already_staged';
      }else{
        await stageAwgGrant(db,{
          nodeId:NODE,entitlementId:row.entitlement_id,
          peerPublicKey:row.peer_public_key,
          expectedBillingRevision:revision,
        },key,new Date());
        kind='staged';
      }
    }
  }catch{
    // A missing FI verification or transient billing state cannot
    // accidentally turn a queued device into an applied one.
    kind='retry';
  }
  const next=kind==='retry'
    ?new Date(Date.now()+60_000):now;
  await db.query(
    "UPDATE vpn_awg_device_requests SET state=$4,claimed_at=NULL,"+
    'updated_at=clock_timestamp(),next_attempt_at=$5 '+
    "WHERE entitlement_id=$1 AND node_id=$2 AND peer_public_key=$3 "+
    "AND state='processing'",
    [...where,kind==='blocked'?'blocked':
      kind==='retry'?(row.attempts>=98?'blocked':'queued'):'staged',next],
  );
  return {status:kind};
}
