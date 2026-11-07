/**
 * Dormant node-scoped VPN reconciler. It does not acknowledge the global
 * entitlement and is not wired into the production worker.
 *
 * A node failure must never block another node's revoke. The next scan always
 * reads current state and inspects the node before retrying unknown writes.
 */
import {effectiveDesired,type DesiredAccess,type ObservedAccess,
  type ProvisioningAdapter} from '../../provisioning/src/reconciler.ts';

export interface NodeFanoutStore {
  listNodeIds(entitlementId:string):Promise<string[]>;
  withNodeLock<T>(entitlementId:string,nodeId:string,
    action:(fence:number)=>Promise<T>):Promise<T>;
  readDesired(entitlementId:string,nodeId:string):Promise<DesiredAccess>;
  acknowledge(entitlementId:string,nodeId:string,revision:number,
    fence:number,observedEnabled:boolean):Promise<boolean>;
  retry(entitlementId:string,nodeId:string,reason:string):Promise<void>;
}

export type NodeSyncResult =
  | {status:'synced';revision:number}
  | {status:'retry_required';reason:
      'node_unconfigured'|'expiry_unverified'|'unknown_outcome'|
      'verification_failed'|'state_changed'|'fence_lost'|'node_exception'};

export type NodeSyncOutcome = NodeSyncResult & {nodeId:string};

function matches(observed:ObservedAccess,desired:DesiredAccess,now:Date):boolean {
  if(!desired.enabled&&observed.absent===true&&!observed.enabled)return true;
  if(observed.revision!==desired.revision||observed.enabled!==desired.enabled)
    return false;
  if(!desired.enabled)return true;
  const actual=observed.expiresAt?.getTime();
  const target=desired.expiresAt?.getTime();
  if(actual===undefined||target===undefined||
     !Number.isFinite(actual)||!Number.isFinite(target)||actual<=now.getTime())
    return false;
  return Math.abs(actual-target)<=1000;
}

function identical(a:DesiredAccess,b:DesiredAccess):boolean {
  return a.revision===b.revision&&a.enabled===b.enabled&&
    a.expiresAt?.getTime()===b.expiresAt?.getTime();
}

/** No global billing changes here: per-node state only. */
export async function reconcileAssignedNode(
  entitlementId:string,nodeId:string,store:NodeFanoutStore,
  adapter:ProvisioningAdapter,now:()=>Date=()=>new Date(),
):Promise<NodeSyncResult> {
  return store.withNodeLock(entitlementId,nodeId,async fence=>{
    for(let attempt=0;attempt<4;attempt++){
      const desired=effectiveDesired(await store.readDesired(entitlementId,nodeId),now());
      // The data-plane must independently enforce expiry and revoke, including
      // when the control server becomes unreachable.
      if(adapter.enforcesHardExpiry!==true){
        await store.retry(entitlementId,nodeId,'expiry_unverified');
        return {status:'retry_required',reason:'expiry_unverified'};
      }
      let before:ObservedAccess;
      try { before=await adapter.inspect(entitlementId); }
      catch {
        await store.retry(entitlementId,nodeId,'unknown_outcome');
        return {status:'retry_required',reason:'unknown_outcome'};
      }
      if(!matches(before,desired,now())){
        const opId=[entitlementId,desired.revision,
          desired.enabled?'enable':'disable'].join(':');
        let outcome:'applied'|'unknown'='unknown';
        try { outcome=await adapter.apply(desired,opId); }catch{}
        if(outcome!=='applied'){
          await store.retry(entitlementId,nodeId,'unknown_outcome');
          return {status:'retry_required',reason:'unknown_outcome'};
        }
      }
      const current=effectiveDesired(await store.readDesired(entitlementId,nodeId),now());
      if(!identical(desired,current))continue;
      let observed:ObservedAccess;
      try { observed=await adapter.inspect(entitlementId); }
      catch {
        await store.retry(entitlementId,nodeId,'unknown_outcome');
        return {status:'retry_required',reason:'unknown_outcome'};
      }
      if(!matches(observed,current,now())){
        await store.retry(entitlementId,nodeId,'verification_failed');
        return {status:'retry_required',reason:'verification_failed'};
      }
      if(await store.acknowledge(entitlementId,nodeId,current.revision,
        fence,observed.enabled))
        return {status:'synced',revision:current.revision};
      await store.retry(entitlementId,nodeId,'fence_lost');
      return {status:'retry_required',reason:'fence_lost'};
    }
    await store.retry(entitlementId,nodeId,'state_changed');
    return {status:'retry_required',reason:'state_changed'};
  });
}

/** Bounded fanout. One broken node must not prevent other node revocations. */
export async function reconcileAllAssignedNodes(
  entitlementId:string,store:NodeFanoutStore,
  adapters:ReadonlyMap<string,ProvisioningAdapter>,
  concurrency=3,
):Promise<NodeSyncOutcome[]> {
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)
    throw Error('Unsafe VPN fanout concurrency');
  const nodeIds=[...new Set(await store.listNodeIds(entitlementId))].sort();
  const outcomes=new Array<NodeSyncOutcome>(nodeIds.length);
  let next=0;
  async function run():Promise<void>{
    while(next<nodeIds.length){
      const i=next++;
      const nodeId=nodeIds[i];
      const adapter=adapters.get(nodeId);
      if(!adapter){
        await store.retry(entitlementId,nodeId,'node_unconfigured');
        outcomes[i]={nodeId,status:'retry_required',reason:'node_unconfigured'};
        continue;
      }
      try{
        outcomes[i]={nodeId,...await reconcileAssignedNode(
          entitlementId,nodeId,store,adapter)};
      }catch{
        try{await store.retry(entitlementId,nodeId,'node_exception');}catch{}
        outcomes[i]={nodeId,status:'retry_required',reason:'node_exception'};
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(nodeIds.length,concurrency)},()=>run()));
  return outcomes;
}
