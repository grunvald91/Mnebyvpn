/**
 * Signed control link to the isolated MNEBYVPN Xray agent on the foreign node.
 * Agent code: grunvald91/telegram-proxy-infra/scripts/mnebyvpn-vpn-provisioner.py
 * Not Remnawave; do not send this agent key to Telegram or a web browser.
 * The node independently sweeps expiry and restarts its own Xray child.
 */
import {createHmac} from 'node:crypto';
import type {DesiredAccess,ObservedAccess,ProvisioningAdapter} from './reconciler.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIXED_NODE_URL='http://10.66.77.1:18944/v1/provision';
const WEB_PROFILE_HOST='cdn.servgo.ru';
// One physical egress node with distinct protocol entries for comparison.
// The 89.125.90.0/24 IP registry records country DE; this is a display label,
// not a geolocation-based access decision.
const NODE_DISPLAY_NAME='MNEBYVPN · Germany';
export interface RealityPublicConfig {
  publicKey:string;
  shortId:string;
  port:2053;
}
export interface NodeRecord extends ObservedAccess {
  credential?:string|null;
  reality?:RealityPublicConfig;
}
function parseRealityConfig(value:unknown):RealityPublicConfig {
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw Error('Invalid REALITY node configuration');
  const r=value as Record<string,unknown>;
  if(typeof r.publicKey!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(r.publicKey)||
     typeof r.shortId!=='string'||!/^[0-9a-f]{16}$/.test(r.shortId)||
     r.port!==2053)
    throw Error('Unsafe REALITY node configuration');
  return {publicKey:r.publicKey,shortId:r.shortId,port:2053};
}
function uuid(id:string):string{
  if(!UUID.test(id))throw Error('Invalid UUID for VPN node');
  return id.toLowerCase();
}
export function parseNodeRecord(value:unknown):NodeRecord{
  if(!value||typeof value!=='object')throw Error('Invalid VPN node response');
  const v=value as Record<string,unknown>;
  if(!Number.isSafeInteger(v.revision)||Number(v.revision)<0||
     typeof v.enabled!=='boolean')throw Error('Invalid VPN node status');
  const expiresAt=v.expiresAt===null?null:
    typeof v.expiresAt==='string'?new Date(v.expiresAt):null;
  if(v.enabled&&( !expiresAt || !Number.isFinite(expiresAt.getTime()) ||
    typeof v.credential!=='string'||!UUID.test(v.credential)))
    throw Error('Node returned unsafe active VPN credential');
  // Public Reality parameters may only come from the authenticated, active
  // node inspection. Never synthesize public links before on-node readiness.
  const reality=v.enabled&&v.reality!==undefined
    ?parseRealityConfig(v.reality):undefined;
  return {revision:Number(v.revision),enabled:v.enabled,
    expiresAt,credential:v.enabled?String(v.credential):null,
    ...(reality?{reality}:{})};
}
export function makeVpnImportUri(credential:string):string {
  const id=uuid(credential);
  const query=new URLSearchParams({
    encryption:'none',security:'tls',type:'ws',
    host:WEB_PROFILE_HOST,sni:WEB_PROFILE_HOST,path:'/mnebyvpn-vpn/ws',
  });
  return 'vless://'+id+'@'+WEB_PROFILE_HOST+':8443?'+query+
    '#'+encodeURIComponent(NODE_DISPLAY_NAME+' · WebSocket TLS');
}
export function makeVpnRealityImportUri(
  credential:string,config:RealityPublicConfig,
  fingerprint:'chrome'|'firefox'='chrome',
):string {
  if(fingerprint!=='chrome'&&fingerprint!=='firefox')
    throw Error('Unsupported REALITY fingerprint');
  const id=uuid(credential);
  const safe=parseRealityConfig(config);
  const query=new URLSearchParams({
    encryption:'none',security:'reality',type:'tcp',
    flow:'xtls-rprx-vision',sni:'www.cloudflare.com',
    fp:fingerprint,pbk:safe.publicKey,sid:safe.shortId,spx:'/',
  });
  return 'vless://'+id+'@'+WEB_PROFILE_HOST+':'+safe.port+'?'+query+
    '#'+encodeURIComponent(NODE_DISPLAY_NAME+
      (fingerprint==='firefox'?' · REALITY Firefox (TEST)':' · REALITY Vision'));
}
export class SignedXrayNodeApi implements ProvisioningAdapter {
  /** The actual isolated Xray agent enforces expiry locally without Panel. */
  readonly enforcesHardExpiry=true as const;
  private readonly key:Buffer;
  private readonly fetcher:typeof fetch;
  /** Foreign node clock minus database/server clock, rounded to whole seconds. */
  private clockOffsetMs=0;
  constructor(keyHex:string,fetcher:typeof fetch=fetch){
    if(!/^[0-9a-f]{64}$/i.test(keyHex))throw Error('Invalid node signing key');
    this.key=Buffer.from(keyHex,'hex');
    this.fetcher=fetcher;
  }
  private async action(body:Record<string,unknown>):Promise<Record<string,unknown>>{
    const raw=JSON.stringify({...body,ts:Math.floor(Date.now()/1000)});
    const mac=createHmac('sha256',this.key).update(raw,'utf8').digest('hex');
    const sentAt=Date.now();
    const reply=await this.fetcher(FIXED_NODE_URL,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(7000),
      headers:{'Content-Type':'application/json','X-Mnebyvpn-Signature':mac},
      body:raw,
    });
    if(!reply.ok)throw Error('VPN node request failed (HTTP '+reply.status+')');
    // Observe the foreign-node wall clock from each signed response. Hard
    // expiry remains anchored to the control-plane deadline after NTP repairs.
    const remoteDate=reply.headers.get('Date');
    const remoteMs=remoteDate?Date.parse(remoteDate):NaN;
    if(!Number.isFinite(remoteMs))throw Error('VPN node clock not observable');
    const midpoint=(sentAt+Date.now())/2;
    const offset=Math.round((remoteMs-midpoint)/1000)*1000;
    if(!Number.isSafeInteger(offset)||Math.abs(offset)>120000)
      throw Error('VPN node clock skew exceeds safe envelope');
    this.clockOffsetMs=offset;
    const json:unknown=await reply.json();
    if(!json||typeof json!=='object'||Array.isArray(json))
      throw Error('Malformed VPN node reply');
    return json as Record<string,unknown>;
  }
  async inspect(entitlementId:string):Promise<NodeRecord>{
    const record=parseNodeRecord(await this.action({op:'inspect',id:uuid(entitlementId)}));
    // Convert the foreign node's wall-clock deadline to control-plane time.
    if(record.expiresAt)
      record.expiresAt=new Date(record.expiresAt.getTime()-this.clockOffsetMs);
    return record;
  }
  async apply(desired:DesiredAccess,operationId:string):Promise<'applied'|'unknown'>{
    const id=uuid(desired.entitlementId);
    const expected=[id,desired.revision,desired.enabled?'enable':'disable'].join(':');
    if(operationId!==expected||!Number.isSafeInteger(desired.revision)||
       desired.revision<1||desired.revision>1000000000)
      throw Error('Stale or invalid VPN node operation');
    if(desired.enabled&&(!desired.expiresAt||!Number.isFinite(desired.expiresAt.getTime())||
      desired.expiresAt.getTime()<=Date.now()))
      throw Error('Invalid node hard expiry');
    // Refresh foreign-clock offset before ENABLE, even on direct apply.
    // This allows the on-node deadline to expire at the intended real time.
    if(desired.enabled)await this.inspect(id);
    const remoteDeadline=desired.enabled
      ?new Date(desired.expiresAt!.getTime()+this.clockOffsetMs).toISOString()
      :null;
    const result=await this.action({op:'apply',id,revision:desired.revision,
      enabled:desired.enabled,
      ...(desired.enabled?{expiresAt:remoteDeadline}:{}),
    });
    if(result.status==='stale')return 'unknown';
    if(result.status!=='applied'||result.revision!==desired.revision)
      throw Error('VPN node apply acknowledgement mismatch');
    return 'applied';
  }
  async profileFor(entitlementId:string,revision:number,expiresAt:Date):
    Promise<string|null>{
    const observed=await this.inspect(entitlementId);
    if(!observed.enabled||observed.revision!==revision||
      !observed.expiresAt||!observed.credential||
      !Number.isFinite(expiresAt.getTime())||expiresAt.getTime()<=Date.now()||
      observed.expiresAt.getTime()<=Date.now()||
      Math.abs(observed.expiresAt.getTime()-expiresAt.getTime())>1000)
      return null;
    const fallback=makeVpnImportUri(observed.credential);
    return observed.reality
      ?[
        makeVpnRealityImportUri(observed.credential,observed.reality),
        // Alternate genuine uTLS ClientHello on the SAME authenticated server.
        // An opt-in test of Android/mobile-network compatibility, not a new key.
        makeVpnRealityImportUri(observed.credential,observed.reality,'firefox'),
        fallback,
      ].join('\n')
      :fallback;
  }
}
