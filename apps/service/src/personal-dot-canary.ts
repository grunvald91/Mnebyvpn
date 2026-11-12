/** Test-only private DNS-over-TLS listener. No production launch allowed.
 * Run with explicit disposable database and two known loopback DNS upstreams.
 * Does not bind :853, touch Nginx, modify CoreDNS, or sell DNS.
 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
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
  const mappedPort=port('MNEBYDNS_CANARY_MAPPED_TCP_PORT','53');
  const directPort=port('MNEBYDNS_CANARY_DIRECT_TCP_PORT','5353');
  if(listenPort<1024||listenPort===mappedPort||listenPort===directPort||
     mappedPort===directPort)throw Error('Unsafe overlapping canary ports');
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
      db,classify,
      mapped:query=>queryLoopbackDnsTcp({host:'127.0.0.1',port:mappedPort},query),
      direct:query=>queryLoopbackDnsTcp({host:'127.0.0.1',port:directPort},query),
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
