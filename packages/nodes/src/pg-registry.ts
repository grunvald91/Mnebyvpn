/**
 * Dormant control-plane storage for additional VPN nodes.
 * No runtime routes or workers call this yet. All allocations are PENDING and
 * must never be interpreted as VPN credentials or successful provisioning.
 */
import type {Pool,PoolClient} from 'pg';
import {assertCapability,assertCountryCode,assertNodeCode,
  eligibleNodes,isNodeEligible} from './registry.ts';
import type {NodeKind,NodeRecord,PlacementRequest} from './registry.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS:readonly NodeKind[]=['normal','regional','special'];
export interface PlannedNode {
  id:string;
  code:string;
  countryCode:string;
  kind:NodeKind;
  capabilities:string[];
  maxClients:number|null;
}
function record(row:Record<string,unknown>):NodeRecord {
  return {
    id:String(row.id),code:String(row.code),
    countryCode:String(row.country_code),
    kind:row.kind as NodeKind,
    state:row.state as NodeRecord['state'],
    capabilities:row.capabilities as string[],
    maxClients:row.max_clients===null?null:Number(row.max_clients),
    allocatedClients:Number(row.allocated_clients),
    verifiedAt:row.verified_at as Date|null,
    operatorApprovedAt:row.operator_approved_at as Date|null,
    lastProbeAt:row.last_probe_at as Date|null,
    lastProbeOk:row.last_probe_ok===true,
    lastHealthyAt:row.last_healthy_at as Date|null,
    enabledForNew:row.enabled_for_new===true,
  };
}
const nodeSql=
  'SELECT n.*, (SELECT count(*) FROM vpn_node_assignments a '+
  "WHERE a.node_id=n.id AND a.state IN ('pending','active','revoking')) AS allocated_clients "+
  'FROM vpn_nodes n ';

export class PgVpnNodeRegistry {
  private readonly pool:Pool;
  constructor(pool:Pool) { this.pool=pool; }
  async registerPlanned(node:PlannedNode):Promise<void> {
    if(!UUID.test(node.id))throw Error('Invalid VPN node ID');
    assertNodeCode(node.code);
    assertCountryCode(node.countryCode);
    if(!KINDS.includes(node.kind)||
       !Array.isArray(node.capabilities)||node.capabilities.length<1||
       node.capabilities.length>32||
       node.capabilities.some(x=>typeof x!=='string'||
         (assertCapabilitySafe(x)===false))||
       (node.maxClients!==null&&(!Number.isSafeInteger(node.maxClients)||
         node.maxClients<1)))
      throw Error('Invalid planned VPN node');
    await this.pool.query(
      'INSERT INTO vpn_nodes(id,code,country_code,kind,capabilities,max_clients) '+
      'VALUES($1,$2,$3,$4,$5,$6)',
      [node.id,node.code,node.countryCode,node.kind,node.capabilities,node.maxClients]);
  }
  /** Called only by a future authenticated/internal probe runner. */
  async recordProbe(nodeId:string,healthy:boolean):Promise<boolean> {
    if(!UUID.test(nodeId)||typeof healthy!=='boolean')
      throw Error('Invalid VPN probe input');
    const result=await this.pool.query(
      'UPDATE vpn_nodes SET last_probe_at=clock_timestamp(), last_probe_ok=$2,'+
      ' last_healthy_at=CASE WHEN $2 THEN clock_timestamp() ELSE last_healthy_at END,'+
      ' updated_at=clock_timestamp() WHERE id=$1',
      [nodeId,healthy]);
    return result.rowCount===1;
  }
  async candidates(request:PlacementRequest):Promise<NodeRecord[]> {
    const {rows}=await this.pool.query(nodeSql);
    return eligibleNodes(rows.map(record),request);
  }
  /** Reserves a slot, not a network credential. Node row lock serializes
   * competing reservations, and no real Xray command is dispatched here. */
  async reserve(entitlementId:string,nodeId:string,request:PlacementRequest):
    Promise<'reserved'|'already'|'unavailable'|'ineligible'> {
    if(!UUID.test(entitlementId)||!UUID.test(nodeId))
      throw Error('Invalid VPN allocation ID');
    const client:PoolClient=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const entitlement=await client.query(
        "SELECT id,revision FROM entitlements WHERE id=$1 AND product='vpn' "+
        "AND state IN ('PAID_PENDING_PROVISIONING','ACTIVE') "+
        'AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR UPDATE',
        [entitlementId]);
      if(entitlement.rows.length!==1){
        await client.query('ROLLBACK');return 'ineligible';
      }
      const node=await client.query('SELECT * FROM vpn_nodes WHERE id=$1 FOR UPDATE',[nodeId]);
      if(node.rows.length!==1){
        await client.query('ROLLBACK');return 'unavailable';
      }
      const existing=await client.query(
        'SELECT state FROM vpn_node_assignments WHERE entitlement_id=$1 AND node_id=$2',
        [entitlementId,nodeId]);
      if(existing.rows.length){
        await client.query('COMMIT');return 'already';
      }
      const occupied=await client.query(
        "SELECT count(*)::int AS count FROM vpn_node_assignments WHERE node_id=$1 "+
        "AND state IN ('pending','active','revoking')",[nodeId]);
      const current=record({...node.rows[0],allocated_clients:occupied.rows[0].count});
      if(!isNodeEligible(current,{...request,now:new Date()})){
        await client.query('ROLLBACK');return 'unavailable';
      }
      await client.query(
        'INSERT INTO vpn_node_assignments(entitlement_id,node_id,desired_revision) '+
        'VALUES($1,$2,$3)',
        [entitlementId,nodeId,entitlement.rows[0].revision]);
      await client.query('COMMIT');return 'reserved';
    }catch(error){
      await client.query('ROLLBACK');throw error;
    }finally{client.release();}
  }
}
function assertCapabilitySafe(v:string):boolean {
  try{assertCapability(v);return true;}catch{return false;}
}
