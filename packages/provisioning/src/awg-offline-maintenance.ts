/**
 * RU188-only, asynchronous AWG entitlement reconciliation.
 *
 * Runs from the trusted worker on a timer, NEVER from a VPN handshake,
 * DNS query, public API request, or Telemt client connection.
 *
 * A signed local grant lives for min(paid_until, 7 days) and is proactively
 * renewed up to two days before local expiry. Billing cancellations are
 * asynchronously staged as signed revocations. A RU188 outage never stalls
 * a previously authorized session; the offline window is bounded.
 */
import type {KeyObject} from 'node:crypto';
import type {Pool} from 'pg';
import {stageAwgGrant,stageAwgRevoke,normalizeAwgBillingRevision} from './awg-controller-grants.ts';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REFRESH_BEFORE_MS=2*24*60*60*1000;
const DELIVERY_RETRY_AFTER_MS=90*1000; // old signed outbox TTL is 40 seconds
const MAX_BATCH=20;

export type OfflineMaintenanceResult={
  stagedRenewals:number;stagedRevocations:number;failed:number;
};

/** One bounded maintenance tick; does no SSH and sends no user data. */
export async function stageDueOfflineAwgMaintenance(
  db:Pick<Pool,'query'|'connect'>, key:KeyObject, now=new Date(), limit=MAX_BATCH,
):Promise<OfflineMaintenanceResult>{
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
     !Number.isSafeInteger(limit)||limit<1||limit>MAX_BATCH||
     key?.type!=='private'||key.asymmetricKeyType!=='ed25519')
    throw Error('Trusted offline AWG maintenance inputs required');

  // Cancellation / expiry takes priority. No new grant or connection request
  // ever triggers these PostgreSQL queries.
  const cancelled=await db.query<{
    node_id:string;entitlement_id:string;allocation_revision:number;
    allocation_state:'applied'|'staged'|'revoked';
  }>(
    'SELECT p.node_id,p.entitlement_id::text AS entitlement_id,'+
    'p.revision AS allocation_revision,p.state AS allocation_state '+
    'FROM vpn_awg_peer_allocations p JOIN entitlements e ON e.id=p.entitlement_id '+
    "WHERE p.node_id='fi-test-01' AND ("+
    "(p.state IN ('applied','staged') AND ("+
    "e.product<>'vpn' OR e.state<>'ACTIVE' OR e.expires_at IS NULL "+
    'OR e.expires_at<=$1)) OR '+
    "(p.state='revoked' AND p.applied_at IS NULL AND p.last_signed_at<=$2)) "+
    'ORDER BY p.expires_at ASC NULLS FIRST LIMIT $3',
    [now,new Date(now.getTime()-DELIVERY_RETRY_AFTER_MS),limit],
  );
  let stagedRevocations=0,stagedRenewals=0,failed=0;
  for(const row of cancelled.rows){
    try{
      if(!UUID.test(row.entitlement_id)||row.node_id!=='fi-test-01'||
         !['applied','staged','revoked'].includes(row.allocation_state)||
         !Number.isSafeInteger(row.allocation_revision))throw Error('Invalid candidate');
      await stageAwgRevoke(db,{
        nodeId:row.node_id,entitlementId:row.entitlement_id,
        expectedAllocationRevision:row.allocation_revision,
        expectedAllocationState:row.allocation_state,
      },key,now);
      stagedRevocations++;
    }catch{
      // A failed individual candidate must not block other cancellations;
      // the job reports aggregate failures without leaking billing IDs.
      failed++;
    }
  }

  const remaining=limit-cancelled.rows.length;
  if(remaining>0){
    const renew=await db.query<{
      node_id:string;entitlement_id:string;allocation_revision:number;
      billing_revision:number;peer_public_key:string;
      allocation_state:'applied'|'staged';
    }>(
      'SELECT p.node_id,p.entitlement_id::text AS entitlement_id,'+
      'p.revision AS allocation_revision,e.revision AS billing_revision,'+
      'p.peer_public_key,p.state AS allocation_state '+
      'FROM vpn_awg_peer_allocations p JOIN entitlements e ON e.id=p.entitlement_id '+
      "WHERE p.node_id='fi-test-01' AND "+
      "e.product='vpn' AND e.state='ACTIVE' AND e.expires_at>$1 AND ("+
      "(p.state='applied' AND p.expires_at<=$2) OR "+
      "(p.state='staged' AND p.applied_at IS NULL AND p.last_signed_at<=$3)) "+
      'ORDER BY p.expires_at ASC LIMIT $4',
      [now,new Date(now.getTime()+REFRESH_BEFORE_MS),
       new Date(now.getTime()-DELIVERY_RETRY_AFTER_MS),remaining],
    );
    for(const row of renew.rows){
      try{
        const billingRevision=normalizeAwgBillingRevision(row.billing_revision);
        if(!UUID.test(row.entitlement_id)||row.node_id!=='fi-test-01'||
           !['applied','staged'].includes(row.allocation_state)||
           !Number.isSafeInteger(row.allocation_revision)||
           billingRevision===null)throw Error('Invalid candidate');
        await stageAwgGrant(db,{
          nodeId:row.node_id,entitlementId:row.entitlement_id,
          peerPublicKey:row.peer_public_key,
          expectedBillingRevision:billingRevision,
          expectedAllocationRevision:row.allocation_revision,
          expectedAllocationState:row.allocation_state,
        },key,now);
        stagedRenewals++;
      }catch{
        failed++;
      }
    }
  }
  return {stagedRenewals,stagedRevocations,failed};
}
