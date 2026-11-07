/**
 * Future multi-node subscription body, not wired to the current /sub HTTP route.
 * A bearer token is verified against the business DB on every read. A node
 * profile only appears after node-level acknowledgement and live observation.
 * No profile, credential, token or node secret is logged or persisted here.
 */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';

const TOKEN=/^[A-Za-z0-9_-]{43}$/;
export interface NodeProfileProvider {
  profileFor(entitlementId:string,revision:number,expiresAt:Date):
    Promise<string|null>;
}
export interface MultiNodeSubscription {
  entitlementId:string;
  expiresAt:Date;
  profiles:string[];
  text:string;
}
function isExpectedVless(value:string,expected:{
  host:string;port:number;sni:string;wsPath:string;
}):boolean {
  if(value.includes('\n')||value.includes('\r')||value.length>4096)
    return false;
  try{
    const url=new URL(value);
    return url.protocol==='vless:'&&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        decodeURIComponent(url.username))&&
      url.password===''&&url.hostname===expected.host.toLowerCase()&&
      Number(url.port)===expected.port&&
      url.searchParams.get('security')==='tls'&&
      url.searchParams.get('encryption')==='none'&&
      url.searchParams.get('type')==='ws'&&
      url.searchParams.get('host')===expected.host&&
      url.searchParams.get('sni')===expected.sni&&
      url.searchParams.get('path')===expected.wsPath;
  }catch{return false;}
}
export function subscriptionText(profiles:readonly string[]):string {
  if(!profiles.length)return '';
  if(profiles.some(p=>p.includes('\n')||p.includes('\r')))throw Error('Invalid profile line');
  return profiles.join('\n')+'\n';
}
/** Called behind the existing authenticated subscription route only after
 * production E2E and explicit switch to the multi-node provider. */
export async function loadMultiNodeSubscription(
  pool:Pool,bearer:string,
  providers:ReadonlyMap<string,NodeProfileProvider>,
):Promise<MultiNodeSubscription|null> {
  if(!TOKEN.test(bearer))return null;
  const digest=createHash('sha256').update(bearer,'utf8').digest('hex');
  const owner=await pool.query(
    `SELECT e.id,e.revision,e.expires_at
       FROM vpn_subscription_links l
       JOIN entitlements e ON e.id=l.entitlement_id
      WHERE l.token_sha256=$1 AND l.revoked_at IS NULL
        AND e.product='vpn' AND e.state='ACTIVE'
        AND e.quota_state='AVAILABLE'
        AND e.expires_at>clock_timestamp() LIMIT 1`,[digest]);
  if(owner.rows.length!==1)return null;
  const {id,revision,expires_at}=owner.rows[0];
  const entitlementId=String(id);
  const expectedRevision=Number(revision);
  const expiresAt=expires_at as Date;
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||
     !(expiresAt instanceof Date)||expiresAt.getTime()<=Date.now())
    return null;

  const eligibleNodesSql=`SELECT n.id,n.client_host,n.client_port,n.client_sni,n.client_ws_path,
              a.applied_node_revision
       FROM vpn_node_assignments a
       JOIN vpn_nodes n ON n.id=a.node_id
       JOIN entitlements e ON e.id=a.entitlement_id
      WHERE a.entitlement_id=$1
        AND a.state='active'
        AND a.applied_revision=$2 AND a.desired_revision=$2
        AND a.applied_node_revision=a.desired_node_revision
        AND a.applied_node_revision>0
        AND a.last_observed_at IS NOT NULL
        AND e.revision=$2 AND e.state='ACTIVE'
        AND e.quota_state='AVAILABLE' AND e.expires_at>clock_timestamp()
        AND n.state IN ('verified','draining')
        AND (n.kind<>'special' OR a.allow_special=true)
        AND n.operator_approved_at IS NOT NULL
        AND n.verified_at IS NOT NULL AND n.verification_report_sha256 IS NOT NULL
        AND n.last_probe_ok = true
        AND n.last_probe_at >= clock_timestamp() - interval '120 seconds'
        AND n.last_healthy_at >= clock_timestamp() - interval '120 seconds'
        AND n.client_host IS NOT NULL AND n.client_port IS NOT NULL
        AND n.client_sni IS NOT NULL AND n.client_ws_path IS NOT NULL
      ORDER BY n.code`;
  const nodes=await pool.query(eligibleNodesSql,[entitlementId,expectedRevision]);
  const candidates:Array<{nodeId:string;profile:string;endpoint:string}>=[];
  const endpoints=new Set<string>();
  for(const n of nodes.rows){
    const provider=providers.get(String(n.id));
    if(!provider)continue;
    let profile:string|null;
    try{profile=await provider.profileFor(entitlementId,Number(n.applied_node_revision),expiresAt);}
    catch{continue;}
    const host=String(n.client_host),port=Number(n.client_port);
    const sni=String(n.client_sni),wsPath=String(n.client_ws_path);
    if(profile&&!isExpectedVless(profile,{host,port,sni,wsPath})){
      continue;
    }
    if(!profile)continue;
    const endpoint=[host,port,sni,wsPath,Number(n.applied_node_revision)].join(':');
    if(endpoints.has(endpoint))continue;
    endpoints.add(endpoint);
    candidates.push({nodeId:String(n.id),profile,endpoint});
  }
  if(!candidates.length||Date.now()>=expiresAt.getTime())return null;
  // A revoked bearer may race profile retrieval: check entitlement/token again.
  const recent=await pool.query(
    `SELECT 1 FROM vpn_subscription_links l
       JOIN entitlements e ON e.id=l.entitlement_id
      WHERE l.token_sha256=$1 AND l.revoked_at IS NULL
        AND e.id=$2 AND e.revision=$3 AND e.state='ACTIVE'
        AND e.quota_state='AVAILABLE'
        AND e.expires_at>clock_timestamp() LIMIT 1`,
    [digest,entitlementId,expectedRevision]);
  if(recent.rows.length!==1)return null;
  // Node eligibility can change without advancing the global entitlement.
  // Recheck assignments/health/routes after slow upstream profile retrieval.
  const stillEligible=await pool.query(eligibleNodesSql,[entitlementId,expectedRevision]);
  const allowed=new Map(stillEligible.rows.map(n=>[String(n.id),
    [String(n.client_host),Number(n.client_port),String(n.client_sni),
      String(n.client_ws_path),Number(n.applied_node_revision)].join(':')]));
  const profiles=candidates.filter(c=>allowed.get(c.nodeId)===c.endpoint).map(c=>c.profile);
  if(!profiles.length||Date.now()>=expiresAt.getTime())return null;
  return {entitlementId,expiresAt,profiles,text:subscriptionText(profiles)};
}
