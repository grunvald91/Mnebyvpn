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
import {deriveSubscriptionAwgIdentity} from './awg-in-subscription.ts';
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

/**
 * Automatic subscription-wide FI217 enrollment. RU188 is the single source
 * of truth: every active, node-acknowledged VPN entitlement has the right to
 * the same FI pool, without a second purchase, link or browser registration.
 *
 * This function only queues the existing public-key enrollment operation.
 * Actual signed lease, FI application and acknowledgement still use the
 * already deployed, asynchronous AWG outbox and trusted delivery worker.
 * No packet or subscription HTTP request waits for this loop.
 */
export async function enqueueFiAwgActiveSubscriptions(
  db:Pick<Pool,'query'>,identityRoot:string,limit=12,
):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>40)
    throw Error('Invalid bounded FI subscription batch');
  // Refuse a missing or malformed root even when no customers are present.
  deriveSubscriptionAwgIdentity('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',identityRoot);
  const candidates=await db.query<{
    entitlement_id:string;billing_revision:number|string;
  }>(
    'SELECT e.id::text AS entitlement_id,e.revision AS billing_revision '+
    'FROM entitlements e JOIN provisioning_state v ON '+
    "v.entitlement_id=e.id AND v.adapter='vpn' "+
    'AND v.applied_revision=e.revision AND v.last_observed_at IS NOT NULL '+
    'JOIN vpn_release_flags f ON '+
    "f.feature='vpn_awg_clients' AND f.enabled=true "+
    'JOIN vpn_awg_node_pools p ON '+
    "p.node_id='fi-test-01' AND p.state='verified' "+
    "AND p.endpoint_host='fi.mnebyvpn.site' "+
    "AND p.verified_at>clock_timestamp()-interval '1 hour' "+
    "AND p.verified_at<=clock_timestamp()+interval '30 seconds' "+
    'JOIN vpn_node_enrollment_inventory n ON '+
    "n.node_id=p.node_id AND n.status='enrolled' "+
    "WHERE e.product='vpn' AND e.state='ACTIVE' "+
    'AND e.expires_at>clock_timestamp() '+
    'AND NOT EXISTS(SELECT 1 FROM vpn_awg_device_requests q '+
    'WHERE q.entitlement_id=e.id) '+
    'AND NOT EXISTS(SELECT 1 FROM vpn_awg_peer_allocations a '+
    "WHERE a.entitlement_id=e.id AND a.node_id='fi-test-01') "+
    'ORDER BY e.expires_at ASC,e.id ASC LIMIT $1',[limit],
  );
  let queued=0;
  for(const candidate of candidates.rows){
    const rev=normalizeAwgBillingRevision(candidate.billing_revision);
    if(!UUID.test(candidate.entitlement_id)||rev===null)
      throw Error('Invalid canonical VPN subscription record');
    const identity=deriveSubscriptionAwgIdentity(candidate.entitlement_id,identityRoot);
    // The RU188 worker has no direct INSERT grant on the public-key queue.
    // Call the narrow SECURITY DEFINER gateway which rechecks canonical
    // active billing, signed node freshness and existing peer ownership.
    const result=await db.query<{queued:boolean}>(
      'SELECT public.awg_controller_enqueue_fi_subscription('+
      '$1::uuid,$2::text,$3::bigint) AS queued',
      [candidate.entitlement_id,identity.publicKey,rev],
    );
    if(result.rows.length!==1 ||
       typeof result.rows[0]?.queued!=='boolean')
      throw Error('FI subscriber queue authorization response invalid');
    if(result.rows[0].queued)queued++;
  }
  return queued;
}
