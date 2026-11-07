/**
 * VPN node inventory and placement gate, deliberately independent of billing
 * and live Xray routing. No implicit capacity, health, or "white-list" claims.
 */
export type NodeKind = 'normal'|'regional'|'special';
export type NodeState = 'planned'|'testing'|'canary'|'verified'|
  'degraded'|'draining'|'disabled';

export interface NodeRecord {
  id:string;
  code:string;
  countryCode:string;
  kind:NodeKind;
  state:NodeState;
  capabilities:readonly string[];
  maxClients:number|null;
  allocatedClients:number;
  verifiedAt:Date|null;
  operatorApprovedAt:Date|null;
  lastProbeAt:Date|null;
  lastProbeOk:boolean;
  lastHealthyAt:Date|null;
  enabledForNew:boolean;
}

export interface PlacementRequest {
  capability:string;
  countryCode?:string;
  allowSpecial?:boolean;
  now?:Date;
}

export const NODE_HEALTH_TTL_MS = 120_000;
const TRANSITIONS:Record<NodeState,readonly NodeState[]>={
  planned:['testing','disabled'],
  testing:['canary','disabled'],
  canary:['verified','testing','disabled'],
  verified:['degraded','draining','disabled'],
  degraded:['testing','draining','disabled'],
  draining:['verified','disabled','degraded'],
  disabled:['testing'],
};

export function assertNodeCode(code:string):void {
  if(!/^[a-z][a-z0-9-]{2,48}$/.test(code))
    throw Error('Invalid VPN node code');
}
export function assertCountryCode(code:string):void {
  if(!/^[A-Z]{2}$/.test(code))
    throw Error('Invalid ISO country code');
}
export function assertCapability(capability:string):void {
  if(!/^[a-z][a-z0-9._-]{1,63}$/.test(capability))
    throw Error('Invalid VPN node capability');
}
export function assertNodeTransition(from:NodeState,to:NodeState):void {
  if(!TRANSITIONS[from]?.includes(to))
    throw Error('Forbidden VPN node state transition');
}
export function isNodeEligible(node:NodeRecord,request:PlacementRequest):boolean {
  const now=request.now??new Date();
  if(!Number.isFinite(now.getTime()))throw Error('Invalid placement time');
  assertCapability(request.capability);
  if(request.countryCode!==undefined)assertCountryCode(request.countryCode);
  if(node.state!=='verified'||!node.enabledForNew||
     !node.verifiedAt||!node.operatorApprovedAt||
     !node.lastProbeOk||!node.lastProbeAt||!node.lastHealthyAt)
    return false;
  const age=now.getTime()-node.lastProbeAt.getTime();
  const healthyAge=now.getTime()-node.lastHealthyAt.getTime();
  if(!Number.isFinite(age)||age<0||age>NODE_HEALTH_TTL_MS||
     !Number.isFinite(healthyAge)||healthyAge<0||healthyAge>NODE_HEALTH_TTL_MS)
    return false;
  if(node.kind==='special'&&!request.allowSpecial)return false;
  if(request.countryCode&&node.countryCode!==request.countryCode)return false;
  if(!node.capabilities.includes(request.capability))return false;
  if(!Number.isSafeInteger(node.allocatedClients)||node.allocatedClients<0)
    return false;
  // Unknown capacity must not mean unlimited public admission.
  if(node.maxClients===null||!Number.isSafeInteger(node.maxClients)||
     node.maxClients<=0||node.allocatedClients>=node.maxClients)return false;
  return true;
}
export function eligibleNodes(nodes:readonly NodeRecord[],
  request:PlacementRequest):NodeRecord[] {
  // Selection is informational until the control plane implements node-scoped
  // provisioning acknowledgement and subscription fanout.
  return nodes.filter(n=>isNodeEligible(n,request))
    .sort((a,b)=>a.code.localeCompare(b.code));
}
