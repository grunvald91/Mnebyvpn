/**
 * Explicit VPN provisioning daemon.
 * Panel provisioning is enabled ONLY after an operator has recorded real
 * pinned-version node expiry/partition evidence. This does not self-certify
 * a production data plane or modify the host's existing services.
 */
import {setTimeout as sleep} from 'node:timers/promises';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {RemnawaveApi} from '../../../packages/provisioning/src/remnawave-api.ts';
import {RemnawaveProvisioningAdapter}
  from '../../../packages/provisioning/src/remnawave-adapter.ts';
import {PgOutboxDispatcher,type Product} from '../../../packages/provisioning/src/pg-worker.ts';

export interface VpnDispatcher {
  expireDue():Promise<number>;
  scheduleDriftScan(limit:number,products?:Product[]):Promise<number>;
  processOnce(products?:Product[]):Promise<{status:'empty'|'synced'|'retry';reason?:string}>;
}
export interface VpnWorkerResult {
  expired:number;
  driftQueued:number;
  synced:number;
  retry:number;
}
export async function vpnWorkerCycle(
  dispatcher:VpnDispatcher,cycle:number,maxBatch=10,
):Promise<VpnWorkerResult>{
  if(!Number.isSafeInteger(cycle)||cycle<0||
     !Number.isSafeInteger(maxBatch)||maxBatch<1||maxBatch>100)
    throw Error('Invalid worker configuration');
  const expired=await dispatcher.expireDue();
  const driftQueued=cycle%60===0?await dispatcher.scheduleDriftScan(100,['vpn']):0;
  let synced=0,retry=0;
  for(let i=0;i<maxBatch;i++){
    const result=await dispatcher.processOnce(['vpn']);
    if(result.status==='empty')break;
    if(result.status==='synced')synced++;
    else retry++;
  }
  return {expired,driftQueued,synced,retry};
}
export async function runVpnWorker(
  dispatcher:VpnDispatcher,signal:AbortSignal,
  wait:(ms:number,signal:AbortSignal)=>Promise<void>=
    async(ms,s)=>{await sleep(ms,undefined,{signal:s});},
  onCycle?:(result:VpnWorkerResult)=>void,
):Promise<void>{
  let cycle=0;
  while(!signal.aborted){
    try{
      const result=await vpnWorkerCycle(dispatcher,cycle);
      onCycle?.(result);
      if(Object.values(result).some(Boolean))
        process.stdout.write('vpn-worker '+JSON.stringify(result)+'\n');
    }catch{
      process.stderr.write('vpn-worker cycle failed; retrying\n');
    }
    cycle++;
    if(signal.aborted)break;
    try{await wait(5_000,signal);}
    catch {if(!signal.aborted)throw Error('VPN worker sleep failed');}
  }
}
function configured(name:string):string{
  const value=process.env[name];
  if(!value||!value.trim())throw Error('Missing required VPN worker setting: '+name);
  return value;
}
async function main():Promise<void>{
  if(process.env.MNEBYVPN_ENV!=='production'||
     process.env.MNEBYVPN_PROVISIONING_WORKER!=='enabled')
    throw Error('VPN provisioning worker must be explicitly enabled');
  // Panel-only mode can perform verified revokes, but cannot approve ENABLE.
  // Do not accept arbitrary report hashes as node-enforcement proof.
  const api=new RemnawaveApi({
    panelUrl:configured('REMNAWAVE_API_URL'),
    apiToken:configured('REMNAWAVE_API_TOKEN'),
    subscriptionOrigin:configured('VPN_SUBSCRIPTION_ORIGIN'),
    squadUuids:configured('REMNAWAVE_SQUAD_UUIDS').split(',').map(x=>x.trim()),
  });
  const adapter=new RemnawaveProvisioningAdapter(api,evidence);
  const healthPort=Number(process.env.VPN_WORKER_HEALTH_PORT??'8794');
  if(!Number.isSafeInteger(healthPort)||healthPort<1||healthPort>65535)
    throw Error('Invalid VPN_WORKER_HEALTH_PORT');
  const pool=new Pool({
    connectionString:configured('DATABASE_URL'),
    max:3,connectionTimeoutMillis:3000,idleTimeoutMillis:12000,
  });
  const abort=new AbortController();
  const stop=()=>abort.abort();
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  try{
    await pool.query('SELECT 1');
    let lastCycleSuccess=0;
    const health=createServer(async(req,res)=>{
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Type','application/json');
      if(req.url!=='/readyz'||req.method!=='GET'){
        res.writeHead(404).end('{"ready":false}');
        return;
      }
      try{
        if(Date.now()-lastCycleSuccess>=20_000)
          throw Error('Provisioning loop not ready');
        await pool.query('SELECT 1');
        res.writeHead(200).end('{"ready":true}');
      }catch{
        res.writeHead(503).end('{"ready":false}');
      }
    });
    try{
      await new Promise<void>((resolve,reject)=>{
        health.once('error',reject);
        health.listen(healthPort,'127.0.0.1',resolve);
      });
      await runVpnWorker(new PgOutboxDispatcher(pool,{vpn:adapter}),
        abort.signal,undefined,()=>{lastCycleSuccess=Date.now();});
    }finally{
      await new Promise<void>(resolve=>health.close(()=>resolve()));
    }
  }finally{
    process.off('SIGINT',stop);
    process.off('SIGTERM',stop);
    await pool.end();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  await main();
}
