/**
 * Database-side expiry scheduler. Does not assert VPN node enforcement.
 * The existing SQL marks expired entitlements and atomically enqueues DISABLE
 * reconciliation; a separately verified node worker still must apply it.
 */
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {pathToFileURL} from 'node:url';
import {PgOutboxDispatcher} from '../../../packages/provisioning/src/pg-worker.ts';

export interface ExpiryDispatcher {
  expireDue():Promise<number>;
  scheduleDriftScan(limit:number):Promise<number>;
}
export interface ExpiryStats {
  expired:number;
  driftScheduled:number;
}
export async function sweepExpired(
  dispatcher:ExpiryDispatcher,includeDrift:boolean,
):Promise<ExpiryStats>{
  const expired=await dispatcher.expireDue();
  const driftScheduled=includeDrift?await dispatcher.scheduleDriftScan(100):0;
  return {expired,driftScheduled};
}
export async function runExpiryScheduler(
  dispatcher:ExpiryDispatcher,signal:AbortSignal,
  pause:(ms:number,signal:AbortSignal)=>Promise<void>=
    async(ms,s)=>{await delay(ms,undefined,{signal:s});},
):Promise<void>{
  let iteration=0;
  while(!signal.aborted){
    try {
      const result=await sweepExpired(dispatcher,iteration%5===0);
      if(result.expired||result.driftScheduled)
        process.stdout.write('vpn-expiry-sweep '+JSON.stringify(result)+'\n');
    }catch{
      // Do not log database error details, customer identifiers or secrets.
      process.stderr.write('vpn-expiry-sweep failed; next cycle will retry\n');
    }
    iteration++;
    if(signal.aborted)break;
    try {await pause(60_000,signal);}
    catch {if(!signal.aborted)throw new Error('Expiry scheduler delay failed');}
  }
}
async function main():Promise<void>{
  if(process.env.MNEBYVPN_ENV!=='production'||
     process.env.MNEBYVPN_EXPIRY_WORKER!=='enabled')
    throw new Error('Production expiry worker must be explicitly enabled');
  const db=process.env.DATABASE_URL;
  if(!db)throw new Error('DATABASE_URL is required');
  const ctrl=new AbortController();
  const onStop=()=>ctrl.abort();
  process.once('SIGTERM',onStop);
  process.once('SIGINT',onStop);
  const pool=new Pool({connectionString:db,max:2,connectionTimeoutMillis:3000});
  try {
    await runExpiryScheduler(new PgOutboxDispatcher(pool),ctrl.signal);
  }finally{
    process.off('SIGTERM',onStop);
    process.off('SIGINT',onStop);
    await pool.end();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  await main();
}
