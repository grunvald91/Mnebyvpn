/** Bounded provisioning/expiry/drift worker loop.
 * Offline contract only: not a real VPN/DNS adapter or deployment.
 * Production MUST inject verified adapters before activation.
 */
import {setTimeout as delay} from 'node:timers/promises';
import type {PgOutboxDispatcher} from './pg-worker.ts';

export interface WorkerCyclePort {
  expireDue():Promise<number>;
  scheduleDriftScan(limit?:number):Promise<number>;
  processOnce():Promise<{status:'empty'|'synced'|'retry';reason?:string}>;
}
export interface WorkerCycleReport {
  expired:number;driftScheduled:number;synced:number;retried:number;
}
export async function runProvisioningCycle(
  worker:WorkerCyclePort,maxSignals=20,
):Promise<WorkerCycleReport> {
  if(!Number.isSafeInteger(maxSignals)||maxSignals<1||maxSignals>100)
    throw new Error('Invalid maximum cycle size');
  const expired=await worker.expireDue();
  const driftScheduled=await worker.scheduleDriftScan(100);
  let synced=0,retried=0;
  for(let n=0;n<maxSignals;n++){
    const result=await worker.processOnce();
    if(result.status==='empty')break;
    if(result.status==='synced')synced++;
    else retried++;
  }
  return {expired,driftScheduled,synced,retried};
}
/** Runs only when explicitly started as a process. No silent background job. */
export async function runProvisioningLoop(
  worker:WorkerCyclePort,signal:AbortSignal,
  onCycle:(report:WorkerCycleReport)=>void,
  intervalMs=5000,
):Promise<void> {
  if(!Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>3600000)
    throw new Error('Invalid interval');
  while(!signal.aborted) {
    try {
      onCycle(await runProvisioningCycle(worker));
    } catch(error) {
      // Logs should include a bounded error category, not credentials or URLs.
      onCycle({expired:0,driftScheduled:0,synced:0,retried:1});
    }
    try {await delay(intervalMs,undefined,{signal});}
    catch {if(!signal.aborted)throw new Error('Provisioning loop sleep failed');}
  }
}
export type {PgOutboxDispatcher};
