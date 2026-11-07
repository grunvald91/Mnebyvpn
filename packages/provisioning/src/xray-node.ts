/**
 * Signed control link to the isolated MNEBYVPN Xray agent on the foreign node.
 * Agent code: grunvald91/telegram-proxy-infra/scripts/mnebyvpn-vpn-provisioner.py
 * Not Remnawave; do not send this agent key to Telegram or a web browser.
 * The node independently sweeps expiry and restarts its own Xray child.
 */
import {createHmac} from 'node:crypto';
import type {DesiredAccess,ObservedAccess,ProvisioningAdapter} from './reconciler.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Optional route for a separately verified VPN node.
 * Existing deployments retain the fixed legacy route until explicitly configured.
 */
export interface XrayNodeRoute {
  controlUrl:string;
  publicHost:string;
  publicPort:number;
  tlsServerName:string;
  wsPath:string;
  label:string;
}
const DEFAULT_ROUTE:XrayNodeRoute={
  controlUrl:'http://10.66.77.1:18944/v1/provision',
  publicHost:'cdn.servgo.ru',publicPort:8443,
  tlsServerName:'cdn.servgo.ru',wsPath:'/mnebyvpn-vpn/ws',
  label:'MNEBYVPN',
};
export function validateXrayNodeRoute(route:XrayNodeRoute):XrayNodeRoute {
  const control=new URL(route.controlUrl);
  const ipv4=/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(control.hostname);
  const octets=control.hostname.split('.').map(Number);
  const privateIpv4=ipv4&&octets.every(x=>x<=255)&&(
    octets[0]===10||octets[0]===127||
    (octets[0]===192&&octets[1]===168)||
    (octets[0]===172&&octets[1]>=16&&octets[1]<=31));
  if(control.username||control.password||control.search||control.hash||
     control.pathname!=='/v1/provision'||
     !(control.protocol==='https:'||(control.protocol==='http:'&&privateIpv4)))
    throw Error('Unsafe VPN node control endpoint');
  const host=/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;
  if(!host.test(route.publicHost)||!host.test(route.tlsServerName)||
     !route.publicHost.includes('.')||!route.tlsServerName.includes('.')||
     !Number.isSafeInteger(route.publicPort)||route.publicPort<1||route.publicPort>65535||
     !/^\/[a-z0-9/_-]{1,100}$/i.test(route.wsPath)||
     !/^[\p{L}\p{N} _-]{1,48}$/u.test(route.label))
    throw Error('Unsafe VPN node client profile');
  return {...route};
}
export interface NodeRecord extends ObservedAccess {
  credential?:string|null;
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
  return {revision:Number(v.revision),enabled:v.enabled,
    expiresAt,credential:v.enabled?String(v.credential):null};
}
export function makeVpnImportUri(
  credential:string,route:XrayNodeRoute=DEFAULT_ROUTE,
):string {
  const id=uuid(credential);
  const safe=validateXrayNodeRoute(route);
  const query=new URLSearchParams({
    encryption:'none',security:'tls',type:'ws',
    host:safe.publicHost,sni:safe.tlsServerName,path:safe.wsPath,
  });
  return 'vless://'+id+'@'+safe.publicHost+':'+safe.publicPort+'?'+query+
    '#'+encodeURIComponent(safe.label);
}
export class SignedXrayNodeApi implements ProvisioningAdapter {
  /** The actual isolated Xray agent enforces expiry locally without Panel. */
  readonly enforcesHardExpiry=true as const;
  private readonly key:Buffer;
  private readonly fetcher:typeof fetch;
  private readonly route:XrayNodeRoute;
  /** Foreign node clock minus database/server clock, rounded to whole seconds. */
  private clockOffsetMs=0;
  constructor(keyHex:string,fetcher:typeof fetch=fetch,route:XrayNodeRoute=DEFAULT_ROUTE){
    if(!/^[0-9a-f]{64}$/i.test(keyHex))throw Error('Invalid node signing key');
    this.key=Buffer.from(keyHex,'hex');
    this.fetcher=fetcher;
    this.route=validateXrayNodeRoute(route);
  }
  private async action(body:Record<string,unknown>):Promise<Record<string,unknown>>{
    const raw=JSON.stringify({...body,ts:Math.floor(Date.now()/1000)});
    const mac=createHmac('sha256',this.key).update(raw,'utf8').digest('hex');
    const sentAt=Date.now();
    const reply=await this.fetcher(this.route.controlUrl,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(7000),
      headers:{'Content-Type':'application/json','X-Mnebyvpn-Signature':mac},
      body:raw,
    });
    if(!reply.ok)throw Error('VPN node request failed (HTTP '+reply.status+')');
    // The dedicated node currently has unsynchronized NTP. Its Date header is
    // authoritative for relative TTL. Do not ever extend a customer deadline
    // by treating a foreign, 30-second-behind clock as our local clock.
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
      Math.abs(observed.expiresAt.getTime()-expiresAt.getTime())>1000)
      return null;
    return makeVpnImportUri(observed.credential,this.route);
  }
}
