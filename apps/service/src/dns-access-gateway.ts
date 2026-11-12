/** Opt-in, LOOPBACK-ONLY DoT authenticated facade for existing CoreDNS.
 * This process does NOT add a public ingress/port, change DNS, perform SNI
 * passthrough, or enable customer payments. A separately reviewed TLS
 * wildcard certificate and public SNI route are needed before activation.
 */
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {createPersonalDotGateway} from '../../../packages/dns-access/src/dot-gateway.ts';

function required(name:string):string{
  const value=process.env[name];
  if(!value||!value.trim())throw Error('Missing private DNS gateway configuration: '+name);
  return value;
}
async function main():Promise<void>{
  if(process.env.MNEBYVPN_ENV!=='production' ||
     process.env.MNEBYDNS_PERSONAL_DOT_GATEWAY!=='enabled')
    throw Error('Personal DNS gateway is disabled by default');
  const port=Number(process.env.MNEBYDNS_PERSONAL_DOT_PORT??'8853');
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    throw Error('Invalid private DNS gateway port');
  const upstreamPort=Number(process.env.MNEBYDNS_COREDNS_TCP_PORT??'53');
  if(!Number.isSafeInteger(upstreamPort)||upstreamPort<1||upstreamPort>65535)
    throw Error('Invalid CoreDNS TCP port');

  const db=new Pool({
    connectionString:required('MNEBYDNS_RESOLVER_DATABASE_URL'),
    max:12,connectionTimeoutMillis:1000,idleTimeoutMillis:10000,
    statement_timeout:1100,query_timeout:1500,
  });
  try{
    // Production role must be NOLOGIN + narrowly granted EXECUTE. The
    // login used here must be an independently approved member of that role.
    await db.query('SELECT 1');
    const server=createPersonalDotGateway({
      key:readFileSync(required('MNEBYDNS_WILDCARD_TLS_KEY_FILE')),
      cert:readFileSync(required('MNEBYDNS_WILDCARD_TLS_CERT_FILE')),
      db,upstreamHost:'127.0.0.1',upstreamPort,queryDeadlineMs:1500,
    });
    const shutdown=()=>{
      server.close(()=>{void db.end();});
    };
    process.once('SIGTERM',shutdown);
    process.once('SIGINT',shutdown);
    // Never bind the public interface as a side effect of a feature branch.
    server.listen(port,'127.0.0.1',()=>{
      console.info('MNEBYDNS customer DoT gateway listening on loopback');
    });
  }catch(error){
    await db.end();
    throw error;
  }
}
void main().catch(()=>{
  console.error('MNEBYDNS personal DoT gateway unavailable');
  process.exitCode=1;
});
