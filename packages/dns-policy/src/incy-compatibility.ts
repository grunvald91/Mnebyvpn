/**
 * Opt-in INCY routing-profile compatibility experiment for strict Android DoT.
 *
 * INCY has separate Remote/Domestic DNS policies and route policies.
 * This does NOT alter any running app or VPN subscription. The raw profile
 * supplied by the device must be reviewed by the owner before import.
 *
 * A direct exception for the user-chosen DoT endpoint might avoid an INCY
 * TUN loop, but Android Private DNS/VPN compatibility cannot be confirmed
 * without testing a particular INCY build and its actual VPN connection.
 */
const DOT_HOST='dns.mnebyvpn.site';
const DOT_IP='89.125.90.101/32';

type RouteProfile = {
  Name: string;
  DirectSites?: string[];
  DirectIp?: string[];
  ProxySites?: string[];
  ProxyIp?: string[];
  [key:string]: unknown;
};

export interface IncyCompatibilityTrial {
  profile:RouteProfile;
  readonly changes:readonly string[];
  readonly verifiedOnDevice:false;
}

function assertStrings(name:string,val:unknown):string[]{
  if(val===undefined)return [];
  if(!Array.isArray(val)||val.length>500||
     val.some(x=>typeof x!=='string'||x.length>300))
    throw Error('Invalid INCY '+name);
  return val;
}
function uniq(list:string[]):string[]{return [...new Set(list)];}

/** Preserve existing DNS selection, GlobalProxy and paid VPN subscription. */
export function stageIncyPrivateDnsCompatibility(input:unknown):IncyCompatibilityTrial{
  if(!input||typeof input!=='object'||Array.isArray(input))
    throw Error('Expected INCY JSON routing profile object');
  const base=input as Record<string,unknown>;
  for(const forbidden of ['__proto__','constructor','prototype','inbounds','outbounds']){
    if(Object.hasOwn(base,forbidden))
      throw Error('Unsupported or unsafe INCY configuration: '+forbidden);
  }
  if(typeof base.Name!=='string'||base.Name.length<1||base.Name.length>96)
    throw Error('INCY routing profile Name required');
  if(!['true','false'].includes(String(base.GlobalProxy)))
    throw Error('INCY GlobalProxy setting must be explicitly preserved');
  const directSites=assertStrings('DirectSites',base.DirectSites);
  const directIp=assertStrings('DirectIp',base.DirectIp);
  const proxySites=assertStrings('ProxySites',base.ProxySites);
  const proxyIp=assertStrings('ProxyIp',base.ProxyIp);
  if(proxySites.some(x=>x.toLowerCase().includes(DOT_HOST))||
     proxyIp.length!==0)
    throw Error('Profile has potentially conflicting proxy rules: manual inspection required');
  // Existing direct CIDR is not removed, and global routing is not weakened.
  const changes:string[]=[];
  if(!directSites.includes(DOT_HOST))changes.push('add exact DoT hostname to DirectSites');
  if(!directIp.includes(DOT_IP))changes.push('add foreign DoT single-IP route to DirectIp');
  const profile={
    ...base,
    Name:base.Name as string,
    DirectSites:uniq([...directSites,DOT_HOST]),
    DirectIp:uniq([...directIp,DOT_IP]),
  } as RouteProfile;
  return {profile,changes,verifiedOnDevice:false};
}
