/** Opt-in private Telemt reconciliation (same node as direct-ozon admin API).
 * Gate to verified direct-ozon via SSH loopback bridge; NEVER scan general
 * customer entitlements before public E2E and revocation checks.
 */
import {Pool} from 'pg';
import {pathToFileURL} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {TelemtAdminClient,reconcileDnsProxyBonuses}
  from '../../../packages/web/src/telegram-proxy-provisioning.ts';
import {createTelemtUnixTransport,OWNER_TELEMT_SSH_SOCKET}
  from '../../../packages/web/src/telegram-proxy-unix-transport.ts';

async function main():Promise<void>{
  if(process.env.MNEBYVPN_ENV!=='production'||
     process.env.DNS_MT_PROXY_BONUS_WORKER!=='enabled'||
     process.env.DNS_MT_PROXY_OWNER_ONLY!=='yes')
    throw Error('MTProxy provisioning worker not activated');
  const url=process.env.DATABASE_URL??'';
  if(!url.startsWith('postgresql://'))throw Error('Canonical PostgreSQL is required');
  const key=process.env.WEB_DNS_MT_PROXY_BONUS_KEY??'';
  const domain=process.env.DNS_MT_PROXY_TLS_DOMAIN??'';
  if(process.env.DNS_MT_PROXY_TELEMT_SOCKET!==OWNER_TELEMT_SSH_SOCKET)
    throw Error('Private owner Telemt SSH socket is mandatory');
  const admin=new TelemtAdminClient(
    'http://127.0.0.1:9096/',
    process.env.DNS_MT_PROXY_TELEMT_AUTH??'',
    createTelemtUnixTransport(OWNER_TELEMT_SSH_SOCKET));
  const db=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000});
  const abort=new AbortController();
  const stop=()=>abort.abort();
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  try{
    await db.query('SELECT 1 FROM dns_mtproxy_bonus_credentials LIMIT 1');
    while(!abort.signal.aborted){
      try{
        const done=await reconcileDnsProxyBonuses(db,admin,key,domain,50,true);
        // Strictly aggregate statuses; never log customer details or secrets.
        if(Object.values(done).some(Boolean))
          console.info('MNEBYVPN_DNS_MTPROXY_RECONCILE',JSON.stringify(done));
      }catch{console.error('MNEBYVPN_DNS_MTPROXY_RECONCILE_RETRY');}
      try{await pause(60_000,undefined,{signal:abort.signal});}
      catch{if(!abort.signal.aborted)throw Error('Worker sleep failed');}
    }
  }finally{
    process.off('SIGTERM',stop);process.off('SIGINT',stop);
    await db.end();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  await main().catch(()=>{console.error('MNEBYVPN_DNS_MTPROXY_WORKER_STOPPED');process.exitCode=1;});
