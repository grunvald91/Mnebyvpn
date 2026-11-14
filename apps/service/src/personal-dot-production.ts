/** Explicitly activated PRIVATE personal DNS-over-TLS sidecar.
 * It never binds public :853 or rewrites an existing CoreDNS/Nginx listener.
 * External SNI demux is a separate guarded infrastructure release.
 *
 * Trust boundary: wildcard TLS cert + 12-symbol SNI + positive-only cached
 * PostgreSQL credential recognition for at most 60 seconds. Every premium
 * DNS message still performs database quota reservation and settlement;
 * ordinary/direct DNS messages remain unmetered. Revocation of direct-only
 * access becomes visible on the next recognition check, no later than 60s.
 */
import {readFileSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';
import {createServer} from 'node:http';
import {isIP} from 'node:net';
import {Pool} from 'pg';
import {pinnedCanaryPolicy} from './personal-dot-canary.ts';
import {queryVerifiedDotTls,type VerifiedDotUpstream}
  from '../../../packages/dns-policy/src/verified-dot-upstream.ts';
import {createPersonalDotListener}
  from '../../../packages/dns-policy/src/personal-dot-listener.ts';

const WILDCARD='aaaaaaaaaaaa.dns.mnebyvpn.site';

function required(name:string):string{
  const val=process.env[name];
  if(typeof val!=='string'||!val.trim())throw Error('Missing personal DoT configuration: '+name);
  return val;
}
export function privateBindIp(host:string):boolean{
  if(isIP(host)!==4)return false;
  const p=host.split('.').map(Number);
  return host==='127.0.0.1'||p[0]===10||
    (p[0]===172&&p[1]>=16&&p[1]<=31)||
    (p[0]===192&&p[1]===168);
}
/** Listener sockets must stay unprivileged, but verified upstream DoT uses
 * the IANA-standard port 853. Confusing them prevents the gateway boot.
 */
export function personalDotPort(value:number,minPort=1024):number{
  if(!Number.isSafeInteger(value)||value<minPort||value>65535)
    throw Error('Unsafe personal DoT port');
  return value;
}
function port(name:string,fallback:number,minPort=1024):number{
  const value=process.env[name]===undefined?fallback:Number(process.env[name]);
  try{return personalDotPort(value,minPort);}catch{
    throw Error('Unsafe personal DoT port '+name);
  }
}
function tlsUpstream(prefix:'MAPPED'|'DIRECT'):VerifiedDotUpstream{
  const address=required('MNEBYDNS_PERSONAL_'+prefix+'_DOT_IP');
  const servername=required('MNEBYDNS_PERSONAL_'+prefix+'_DOT_NAME');
  const portNumber=port('MNEBYDNS_PERSONAL_'+prefix+'_DOT_PORT',853,1);
  if(isIP(address)!==4 || !/^[a-z0-9.-]{3,253}$/.test(servername))
    throw Error('Invalid verified personal upstream');
  return {address,servername,port:portNumber};
}
/** Startup conditions are independent of bot invoice publication.
 * They do NOT replace an external Android Wi-Fi/LTE DoT acceptance test.
 */
export async function runPersonalDotProduction():Promise<void>{
  if(process.env.MNEBYVPN_ENV!=='production'||
     process.env.MNEBYDNS_PERSONAL_DOT_ENABLED!=='yes')
    throw Error('Personal DoT service not explicitly enabled');
  const host=process.env.MNEBYDNS_PERSONAL_DOT_BIND_IP??'127.0.0.1';
  if(!privateBindIp(host))throw Error('Refusing public personal DNS bind');
  const listenPort=port('MNEBYDNS_PERSONAL_DOT_PORT',8853);
  const healthPort=port('MNEBYDNS_PERSONAL_DOT_HEALTH_PORT',8855);
  if(listenPort===healthPort)throw Error('Personal DoT/health port overlap');
  const key=readFileSync(required('MNEBYDNS_PERSONAL_DOT_TLS_KEY_FILE'));
  const cert=readFileSync(required('MNEBYDNS_PERSONAL_DOT_TLS_CERT_FILE'));
  const x509=new X509Certificate(cert);
  if(!x509.checkHost(WILDCARD,{subject:'default'})||
     Date.parse(x509.validFrom)>Date.now()||
     Date.parse(x509.validTo)<Date.now()+6*60*60*1000)
    throw Error('A valid unexpired personal wildcard TLS certificate is required');
  const mapped=tlsUpstream('MAPPED');
  const direct=tlsUpstream('DIRECT');
  if(mapped.address===direct.address&&mapped.port===direct.port)
    throw Error('Origin DNS must be independent from mapped CoreDNS');
  const classify=pinnedCanaryPolicy(
    readFileSync(required('MNEBYDNS_PERSONAL_DOT_ROUTE_POLICY_FILE')),
    required('MNEBYDNS_PERSONAL_DOT_ROUTE_POLICY_SHA256'),
  );
  const db=new Pool({connectionString:required('DATABASE_URL'),
    max:8,connectionTimeoutMillis:1200,statement_timeout:1150,
    query_timeout:1200,idleTimeoutMillis:10000});
  await db.query('SELECT 1');
  const tlsServer=createPersonalDotListener({
    key,cert,db,classify,
    queryTimeoutMs:8500,
    mapped:(query,signal)=>queryVerifiedDotTls(mapped,query,7000,signal),
    direct:(query,signal)=>queryVerifiedDotTls(direct,query,7000,signal),
  });
  let listening=false;
  const health=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json');
    if(req.method!=='GET'||!['/readyz','/healthz'].includes(req.url??'')){
      res.writeHead(404).end('{}');return;
    }
    try{
      if(!listening||Date.parse(x509.validTo)<=Date.now())throw Error('Not ready');
      await db.query('SELECT 1');
      res.writeHead(200).end('{"ready":true,"component":"personal-dot"}');
    }catch{
      res.writeHead(503).end('{"ready":false}');
    }
  });
  const shutdown=()=>{
    listening=false;
    tlsServer.close(()=>{void db.end();});
    health.close();
  };
  process.once('SIGTERM',shutdown);
  process.once('SIGINT',shutdown);
  tlsServer.on('error',()=>{listening=false;process.exitCode=1;shutdown();});
  try{
  await new Promise<void>((resolve,reject)=>{
    tlsServer.once('error',reject);
    tlsServer.listen(listenPort,host,()=>{
      listening=true;
      tlsServer.off('error',reject);
      resolve();
    });
  });
  await new Promise<void>((resolve,reject)=>{
    health.once('error',reject);
    health.listen(healthPort,'127.0.0.1',()=>{
      health.off('error',reject);
      resolve();
    });
  });
  }catch(err){
    listening=false;
    try{tlsServer.close();}catch{/* not listening yet */}
    try{health.close();}catch{/* not listening yet */}
    await db.end();
    throw err;
  }
  console.info('Personal DoT private SNI listener ready');
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){
  void runPersonalDotProduction().catch(()=>{
    console.error('Personal DoT not ready');process.exitCode=1;
  });
}
