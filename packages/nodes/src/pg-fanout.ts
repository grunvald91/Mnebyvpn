/**
 * PostgreSQL node-scoped synchronization. All network calls are made while
 * holding a dedicated advisory lock for (entitlement,node). DB state remains
 * independent from the live legacy provisioning_state acknowledgement.
 *
 * The caller injects node-specific adapters/keys. This class contains NO keys
 * and exposes NO public HTTP handlers.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool,PoolClient} from 'pg';
import type {NodeFanoutStore} from './fanout.ts';
import type {DesiredAccess} from '../../provisioning/src/reconciler.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validId(id:string):void {
  if(!UUID.test(id))throw Error('Invalid VPN reconciliation ID');
}
function safeNumber(value:unknown):number {
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid VPN revision');
  return n;
}
function validTime(value:unknown):Date|null {
  if(value===null)return null;
  const date=value instanceof Date?value:new Date(String(value));
  if(!Number.isFinite(date.getTime()))throw Error('Invalid VPN deadline');
  return date;
}
interface Row {
  entitlement_id:string;
  entitlement_revision:unknown;
  entitlement_state:string;
  expires_at:Date|null;
  quota_state:string;
  assignment_state:string;
  desired_revision:unknown;
  applied_revision:unknown;
  fencing_token:unknown;
  node_state:string;
  node_kind:string;
  node_verified_at:Date|null;
  node_approved_at:Date|null;
  node_report_sha256:string|null;
  node_enabled_for_new:boolean;
  node_last_probe_at:Date|null;
  node_last_probe_ok:boolean;
  node_last_healthy_at:Date|null;
  max_clients:number|null;
  allocated_clients:unknown;
}
const SELECT= `SELECT
  e.id AS entitlement_id,e.revision AS entitlement_revision,
  e.state AS entitlement_state,e.expires_at,e.quota_state,
  a.state AS assignment_state,a.desired_revision,a.applied_revision,a.fencing_token,
  n.state AS node_state,n.kind AS node_kind,
  n.verified_at AS node_verified_at,n.operator_approved_at AS node_approved_at,
  n.verification_report_sha256 AS node_report_sha256,
  n.enabled_for_new AS node_enabled_for_new,n.last_probe_at AS node_last_probe_at,
  n.last_probe_ok AS node_last_probe_ok,n.last_healthy_at AS node_last_healthy_at,
  n.max_clients,
  (SELECT count(*)::int FROM vpn_node_assignments x WHERE x.node_id=a.node_id
   AND x.state IN ('pending','active','revoking')) AS allocated_clients
  FROM vpn_node_assignments a
  JOIN entitlements e ON e.id=a.entitlement_id AND e.product='vpn'
  JOIN vpn_nodes n ON n.id=a.node_id
  WHERE a.entitlement_id=$1 AND a.node_id=$2`;

function desiredFromRow(r:Row,now:Date):DesiredAccess {
  const revision=safeNumber(r.entitlement_revision);
  const deadline=validTime(r.expires_at);
  const entitled=['ACTIVE','PAID_PENDING_PROVISIONING','PROVISIONING_FAILED'].includes(r.entitlement_state)&&
    r.quota_state==='AVAILABLE'&&deadline!==null&&deadline.getTime()>now.getTime();
  const previouslyActive=r.assignment_state==='active'&&
    ['verified','degraded','draining'].includes(r.node_state)&&
    r.node_approved_at!==null&&r.node_verified_at!==null;
  const probeTime=r.node_last_probe_at?.getTime()??NaN;
  const healthyTime=r.node_last_healthy_at?.getTime()??NaN;
  const max=r.max_clients===null?NaN:Number(r.max_clients);
  const count=safeNumber(r.allocated_clients);
  const readyNew=r.assignment_state==='pending'&&
    r.node_state==='verified'&&r.node_verified_at!==null&&
    r.node_approved_at!==null&&r.node_report_sha256!==null&&
    r.node_enabled_for_new&&r.node_last_probe_ok&&
    Number.isFinite(probeTime)&&probeTime<=now.getTime()&&
    now.getTime()-probeTime<=120000&&
    Number.isFinite(healthyTime)&&healthyTime<=now.getTime()&&
    now.getTime()-healthyTime<=120000&&
    Number.isSafeInteger(max)&&count>0&&count<=max&&
    r.node_kind!=='special'; // Special nodes require a separate opt-in.
  return {entitlementId:r.entitlement_id,revision,
    enabled:entitled&&(previouslyActive||readyNew),
    expiresAt:deadline};
}

export class PgNodeFanoutStore implements NodeFanoutStore {
  private readonly context=new AsyncLocalStorage<PoolClient>();
  constructor(privatePool:Pool){this.pool=privatePool;}
  readonly pool:Pool;
  private query(sql:string,params:unknown[]) {
    const held=this.context.getStore();
    return held?held.query(sql,params):this.pool.query(sql,params);
  }
  async listNodeIds(entitlementId:string):Promise<string[]> {
    validId(entitlementId);
    const {rows}=await this.pool.query(
      "SELECT node_id FROM vpn_node_assignments WHERE entitlement_id=$1 "+
      "AND state<>'revoked' ORDER BY node_id",[entitlementId]);
    return rows.map(x=>String(x.node_id));
  }
  async withNodeLock<T>(entitlementId:string,nodeId:string,
    action:(fence:number)=>Promise<T>):Promise<T> {
    validId(entitlementId);validId(nodeId);
    const client=await this.pool.connect();
    let locked=false,broken=false;
    const key=entitlementId+':'+nodeId;
    try{
      await client.query(
        "SELECT pg_advisory_lock(hashtext('mnebyvpn:node'),hashtext($1))",[key]);
      locked=true;
      const {rows}=await client.query(
        "UPDATE vpn_node_assignments SET fencing_token=fencing_token+1 "+
        "WHERE entitlement_id=$1 AND node_id=$2 RETURNING fencing_token",
        [entitlementId,nodeId]);
      if(rows.length!==1)throw Error('Unknown VPN node assignment');
      const fence=safeNumber(rows[0].fencing_token);
      return await this.context.run(client,()=>action(fence));
    }finally{
      if(locked){
        try{
          const u=await client.query(
            "SELECT pg_advisory_unlock(hashtext('mnebyvpn:node'),hashtext($1)) AS ok",[key]);
          if(u.rows[0]?.ok!==true)broken=true;
        }catch{broken=true;}
      }
      client.release(broken);
      if(broken)throw Error('VPN node advisory lock was lost');
    }
  }
  async readDesired(entitlementId:string,nodeId:string):Promise<DesiredAccess> {
    validId(entitlementId);validId(nodeId);
    const {rows}=await this.query(SELECT,[entitlementId,nodeId]);
    if(rows.length!==1)throw Error('Missing VPN node assignment');
    return desiredFromRow(rows[0] as Row,new Date());
  }
  async acknowledge(entitlementId:string,nodeId:string,revision:number,
    fence:number,observedEnabled:boolean):Promise<boolean> {
    validId(entitlementId);validId(nodeId);
    if(!Number.isSafeInteger(revision)||revision<0||
       !Number.isSafeInteger(fence)||fence<1)
      throw Error('Invalid VPN node acknowledgement');
    const client=this.context.getStore();
    if(!client)throw Error('VPN node acknowledgement needs operation lock');
    await client.query('BEGIN');
    try{
      const {rows}=await client.query(SELECT+' FOR UPDATE OF e,a FOR SHARE OF n',
        [entitlementId,nodeId]);
      if(rows.length!==1){
        await client.query('ROLLBACK');return false;
      }
      const r=rows[0] as Row;
      const latest=desiredFromRow(r,new Date());
      if(safeNumber(r.desired_revision)!==revision||
         latest.revision!==revision||
         safeNumber(r.fencing_token)!==fence||
         latest.enabled!==observedEnabled){
        await client.query('ROLLBACK');return false;
      }
      // A verified disable is terminal at this node revision. Never
      // automatically re-enable under the same revision: the Xray agent
      // forbids opposite-state operations with an unchanged revision.
      // A new entitlement revision may explicitly requeue the assignment.
      const next=observedEnabled?'active':'revoked';
      await client.query(
        "UPDATE vpn_node_assignments SET applied_revision=$3,state=$4,"+
        "last_observed_at=clock_timestamp(),last_error_code=NULL,attempts=0,"+
        "updated_at=clock_timestamp() WHERE entitlement_id=$1 AND node_id=$2",
        [entitlementId,nodeId,revision,next]);
      await client.query('COMMIT');
      return true;
    }catch(error){
      await client.query('ROLLBACK');throw error;
    }
  }
  async retry(entitlementId:string,nodeId:string,reason:string):Promise<void> {
    validId(entitlementId);validId(nodeId);
    if(!/^[a-z_]{1,64}$/.test(reason))throw Error('Invalid VPN node retry code');
    await this.query(
      "UPDATE vpn_node_assignments SET attempts=attempts+1,"+
      "last_error_code=$3,next_attempt_at=clock_timestamp()+interval '60 seconds',"+
      "updated_at=clock_timestamp() WHERE entitlement_id=$1 AND node_id=$2",
      [entitlementId,nodeId,reason]);
  }
}
