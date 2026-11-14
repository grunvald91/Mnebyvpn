/** Shared pinned DNS policy classifier plus a separate test-only canary
 * entrypoint. The classifier is also imported by the production private DoT
 * sidecar. Running this file as a server requires the offline-test environment
 * and loopback/test upstreams; it must never publish a production listener.
 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {queryVerifiedDotTls,type VerifiedDotUpstream}
  from '../../../packages/dns-policy/src/verified-dot-upstream.ts';
import {
  createPersonalDotListener,queryLoopbackDnsTcp,
} from '../../../packages/dns-policy/src/personal-dot-listener.ts';
import type {Classifier} from '../../../packages/dns-policy/src/personal-dot-gateway-core.ts';

function required(key:string):string{
  const v=process.env[key];
  if(!v||!v.trim())throw Error('Missing DoT canary config: '+key);
  return v;
}
function port(key:string,defaultValue:string):number{
  const value=Number(process.env[key]??defaultValue);
  if(!Number.isSafeInteger(value)||value<1||value>65535)
    throw Error('Invalid DoT canary port: '+key);
  return value;
}
/** Snapshot MUST be generated from the currently reviewed CoreDNS premium
 * domain routes. The approved digest pins the exact policy for this run.
 * Never silently maintain a second production domain list.
 */
export function pinnedCanaryPolicy(raw:Buffer,expectedSha:string):Classifier{
  if(!/^[a-f0-9]{64}$/.test(expectedSha)||
     createHash('sha256').update(raw).digest('hex')!==expectedSha)
    throw Error('DoT canary policy digest mismatch');
  const parsed:unknown=JSON.parse(raw.toString('utf8'));
  if(!Array.isArray(parsed)||parsed.length<1||parsed.length>30000||
     parsed.some(s=>typeof s!=='string'||s.length>253||
       !/^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(s)||
       s!==s.toLowerCase()))
    throw Error('Invalid pinned premium DNS domain rules');
  const exact=new Set<string>();
  const suffixes:string[]=[];
  for(const item of parsed as string[]){
    if(item.startsWith('*.'))suffixes.push(item.slice(2));
    else exact.add(item);
  }
  return q=>{
    const name=q.name.toLowerCase();
    return exact.has(name)||suffixes.some(s=>name.endsWith('.'+s))
      ?'premium':'direct';
  };
}
async function main():Promise<void>{
  if(process.env.MNEBYVPN_ENV!=='offline-test'||
     process.env.MNEBYDNS_PERSONAL_DOT_GATEWAY!=='canary')
    throw Error('Production personal DNS ingress is not approved');
  const listenPort=port('MNEBYDNS_CANARY_PORT','8853');
  const mode=process.env.MNEBYDNS_CANARY_UPSTREAM_MODE??'loopback';
  if(!['loopback','verified-dot'].includes(mode))
    throw Error('Unknown personal DNS canary upstream mode');
  const mappedPort=port('MNEBYDNS_CANARY_MAPPED_TCP_PORT','53');
  const directPort=port('MNEBYDNS_CANARY_DIRECT_TCP_PORT','5353');
  if(listenPort<1024||listenPort===mappedPort||listenPort===directPort||
     mappedPort===directPort)throw Error('Unsafe overlapping canary ports');
  const dotConfig=(name:'MAPPED'|'DIRECT'):VerifiedDotUpstream=>({
    address:required('MNEBYDNS_CANARY_'+name+'_DOT_IP'),
    servername:required('MNEBYDNS_CANARY_'+name+'_DOT_TLS_NAME'),
    port:port('MNEBYDNS_CANARY_'+name+'_DOT_PORT','853'),
  });
  let mappedDot:VerifiedDotUpstream|undefined,directDot:VerifiedDotUpstream|undefined;
  if(mode==='verified-dot'){
    if(process.env.MNEBYDNS_CANARY_VERIFIED_UPSTREAM_APPROVED!=='yes')
      throw Error('External verified DoT upstream needs explicit canary approval');
    mappedDot=dotConfig('MAPPED');
    directDot=dotConfig('DIRECT');
    if(mappedDot.address===directDot.address && mappedDot.port===directDot.port)
      throw Error('Direct resolver must be independent of mapped CoreDNS');
  }
  const classify=pinnedCanaryPolicy(
    readFileSync(required('MNEBYDNS_CANARY_ROUTE_POLICY_FILE')),
    required('MNEBYDNS_CANARY_ROUTE_POLICY_SHA256'),
  );
  const db=new Pool({
    connectionString:required('MNEBYDNS_CANARY_DATABASE_URL'),
    max:6,connectionTimeoutMillis:1000,query_timeout:1200,
    statement_timeout:1100,idleTimeoutMillis:10000,
  });
  try{
    await db.query('SELECT 1');
    const server=createPersonalDotListener({
      key:readFileSync(required('MNEBYDNS_CANARY_TLS_KEY_FILE')),
      cert:readFileSync(required('MNEBYDNS_CANARY_TLS_CERT_FILE')),
      db,classify,queryTimeoutMs:mode==='verified-dot'?8500:2500,
      mapped:(query,signal)=>mappedDot
        ?queryVerifiedDotTls(mappedDot,query,7000,signal)
        :queryLoopbackDnsTcp({host:'127.0.0.1',port:mappedPort},query,2000,signal),
      direct:(query,signal)=>directDot
        ?queryVerifiedDotTls(directDot,query,7000,signal)
        :queryLoopbackDnsTcp({host:'127.0.0.1',port:directPort},query,2000,signal),
    });
    server.on('error',()=>{console.error('Private DNS canary listener failed');process.exitCode=1;});
    process.once('SIGTERM',()=>server.close(()=>{void db.end();}));
    process.once('SIGINT',()=>server.close(()=>{void db.end();}));
    server.listen(listenPort,'127.0.0.1',()=>{
      console.info('Private DNS canary listening on loopback only');
    });
  }catch(err){await db.end();throw err;}
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){
  void main().catch(()=>{console.error('Private DNS canary unavailable');process.exitCode=1;});
}
