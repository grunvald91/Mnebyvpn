/**
 * Separate loopback/offline worker process. Explicit start only.
 * No production adapter is shipped or implied by the green CI.
 */
import {Pool} from 'pg';
import {PgOutboxDispatcher} from '../../../packages/provisioning/src/pg-worker.ts';
import {runProvisioningLoop} from '../../../packages/provisioning/src/runner.ts';
export async function startOfflineProvisioningWorker(
  dbUrl:string,signal:AbortSignal,
):Promise<void>{
 if(process.env.MNEBYVPN_ENV!=='offline-test')
   throw new Error('No production node adapters have been verified');
 const pool=new Pool({connectionString:dbUrl,max:4,connectionTimeoutMillis:2500});
 const dispatcher=new PgOutboxDispatcher(pool,{});
 try {
  await runProvisioningLoop(dispatcher,signal,stats=>{
   if(stats.expired||stats.driftScheduled||stats.synced||stats.retried)
     process.stdout.write('offline-provisioning-cycle '+JSON.stringify(stats)+'\n');
  });
 } finally{await pool.end();}
}
if(process.env.MNEBYVPN_PROVISION_WORKER==='offline-test'){
 const ctrl=new AbortController();
 process.on('SIGINT',()=>ctrl.abort());
 process.on('SIGTERM',()=>ctrl.abort());
 const url=process.env.DATABASE_URL;
 if(!url)throw new Error('DATABASE_URL is required');
 await startOfflineProvisioningWorker(url,ctrl.signal);
}
