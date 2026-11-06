/**
 * Narrow Remnawave user-control API. Authoritative contract: docs.rw/api/.
 * The panel alone is NOT proof of node-side hard expiry or packet forwarding.
 * Never log responses: they can contain subscription credentials.
 */
export interface RemnawaveUser {
  username: string;
  status: string;
  expireAt: string;
  subscriptionUrl: string|null;
  description: string|null;
  id: number|null;
}
export type HttpFetch = typeof fetch;
export interface RemnawaveConfig {
  panelUrl: string;
  apiToken: string;
  subscriptionOrigin: string;
  squadUuids: string[];
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SQUAD=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const description=(id:string,revision:number)=>
  'mnebyvpn:'+id.toLowerCase()+':rev:'+revision;

export function remnawaveUsername(entitlementId:string):string {
  if(!UUID.test(entitlementId))throw Error('Invalid entitlement ID');
  return 'mb_'+entitlementId.replace(/-/g,'').toLowerCase();
}
function origin(input:string,permitLoopback=false):string {
  const u=new URL(input);
  const loopback=permitLoopback&&(u.hostname==='127.0.0.1'||u.hostname==='localhost');
  if((u.protocol!=='https:'&&!loopback)||u.username||u.password||
    u.search||u.hash||u.pathname!=='/')
    throw Error('Invalid configured HTTPS origin');
  return u.origin;
}
function user(value:unknown):RemnawaveUser {
  if(!value||typeof value!=='object')throw Error('Invalid Remnawave response');
  const v=value as Record<string,unknown>;
  if(typeof v.username!=='string'||typeof v.status!=='string'||
     typeof v.expireAt!=='string'||!Number.isFinite(Date.parse(v.expireAt)))
    throw Error('Invalid Remnawave user');
  return {username:v.username,status:v.status,expireAt:v.expireAt,
    subscriptionUrl:typeof v.subscriptionUrl==='string'?v.subscriptionUrl:null,
    description:typeof v.description==='string'?v.description:null,
    id:typeof v.id==='number'&&Number.isSafeInteger(v.id)&&v.id>0?v.id:null};
}
function unwrap(value:unknown):unknown {
  if(value&&typeof value==='object'&&'response' in value)
    return (value as Record<string,unknown>).response;
  return value;
}
export class RemnawaveApi {
  private readonly panel:string;
  private readonly subscriptions:string;
  private readonly token:string;
  private readonly fetcher:HttpFetch;
  readonly squadUuids:string[];
  constructor(config:RemnawaveConfig,fetcher:HttpFetch=fetch) {
    this.panel=origin(config.panelUrl,true);
    this.subscriptions=origin(config.subscriptionOrigin);
    if(!config.apiToken||config.apiToken.length<20||/[\r\n]/.test(config.apiToken))
      throw Error('Remnawave API token not configured');
    if(!Array.isArray(config.squadUuids)||config.squadUuids.length<1||
       !config.squadUuids.every(x=>SQUAD.test(x)))
      throw Error('Remnawave squad UUIDs not configured');
    this.token=config.apiToken;
    this.squadUuids=[...config.squadUuids];
    this.fetcher=fetcher;
  }
  private async request(method:'GET'|'POST'|'PATCH',path:string,body?:unknown):
    Promise<{status:number;result:unknown}> {
    const url=new URL(path,this.panel);
    if(url.origin!==this.panel||!url.pathname.startsWith('/api/users'))
      throw Error('Remnawave route not allowed');
    const response=await this.fetcher(url.toString(),{
      method,redirect:'error',signal:AbortSignal.timeout(7000),
      headers:{'Authorization':'Bearer '+this.token,
        ...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
    if(response.status===404)return {status:404,result:null};
    if(!response.ok)throw Error('Remnawave API unavailable (HTTP '+response.status+')');
    return {status:response.status,result:unwrap(await response.json())};
  }
  async getByEntitlement(id:string):Promise<RemnawaveUser|null> {
    const username=remnawaveUsername(id);
    const result=await this.request('GET','/api/users/by-username/'+username);
    if(result.status===404)return null;
    const record=user(result.result);
    if(record.username!==username)throw Error('Remnawave identity mismatch');
    return record;
  }
  /** This only requests a change in the panel; a separate real node probe is mandatory. */
  async applyPanelChange(id:string,revision:number,enabled:boolean,expiresAt:Date|null):
    Promise<RemnawaveUser> {
    const username=remnawaveUsername(id);
    if(!Number.isSafeInteger(revision)||revision<0||
      (enabled&&(!expiresAt||!Number.isFinite(expiresAt.getTime())))||
      (expiresAt&&!Number.isFinite(expiresAt.getTime())))
      throw Error('Invalid access revision or expiry');
    const desc=description(id,revision);
    const current=await this.getByEntitlement(id);
    const effectiveExpiry=expiresAt??(current?new Date(current.expireAt):null);
    if(!effectiveExpiry||!Number.isFinite(effectiveExpiry.getTime()))
      throw Error('Cannot set expiry for absent user');
    const expires=effectiveExpiry.toISOString();
    if(!current) {
      if(!enabled)throw Error('Cannot disable absent profile before node verification');
      await this.request('POST','/api/users',{
        username,status:'ACTIVE',expireAt:expires,
        activeInternalSquads:this.squadUuids,description:desc,
        trafficLimitBytes:0,trafficLimitStrategy:'NO_RESET',
      });
    } else {
      await this.request('PATCH','/api/users',{
        username,status:enabled?'ACTIVE':'DISABLED',expireAt:expires,
        description:desc,
      });
    }
    const after=await this.getByEntitlement(id);
    if(!after||after.status!==(enabled?'ACTIVE':'DISABLED')||
       Math.abs(Date.parse(after.expireAt)-effectiveExpiry.getTime())>1000||
       after.description!==desc)
      throw Error('Remnawave panel read-back mismatch');
    return after;
  }
  /** Only after DB verifies the user owns an ACTIVE, provisioned VPN entitlement. */
  async subscriptionFor(id:string,expectedExpiry:Date,expectedRevision:number):Promise<string|null> {
    const record=await this.getByEntitlement(id);
    if(!record||record.status!=='ACTIVE'||!record.subscriptionUrl||
       record.description!==description(id,expectedRevision))return null;
    if(!Number.isFinite(expectedExpiry.getTime())||expectedExpiry.getTime()<=Date.now())return null;
    if(Math.abs(Date.parse(record.expireAt)-expectedExpiry.getTime())>1000)return null;
    const u=new URL(record.subscriptionUrl);
    if(u.origin!==this.subscriptions||u.username||u.password||
      u.hash||!u.pathname.startsWith('/')||u.pathname==='/')return null;
    return u.toString();
  }
}
