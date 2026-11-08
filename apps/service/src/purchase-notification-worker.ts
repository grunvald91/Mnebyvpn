/**
 * Isolated purchased-VPN Telegram notices. Does not initialize Xray, VPN
 * provisioning, public ports, or payment settlement. Production must supply
 * the pre-existing bot secret and canonical PostgreSQL connection.
 */
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {Pool} from 'pg';
import {PgVpnTrialReadyQueue,TelegramTrialReadySender,processVpnTrialReadyNotices}
  from '../../../packages/notifications/src/vpn-trial-ready.ts';
import {PgVpnPurchaseNoticeQueue,TelegramBotPurchaseSender} from '../../../packages/notifications/src/vpn-purchase.ts';
import {notificationBotToken,runVpnPurchaseNoticeLoop} from './vpn-provisioning-worker.ts';

/** A new trial's node ACK is usually observable within a few seconds. */
export async function runVpnTrialReadyLoop(
  queue:PgVpnTrialReadyQueue,
  sender:TelegramTrialReadySender,
  signal:AbortSignal,
  wait:(ms:number,signal:AbortSignal)=>Promise<void>=
    async(ms,abort)=>{await sleep(ms,undefined,{signal:abort});},
):Promise<void>{
  while(!signal.aborted){
    try{
      const result=await processVpnTrialReadyNotices(queue,sender);
      if(Object.values(result).some(Boolean))
        process.stdout.write('vpn-trial-ready-notifications '+JSON.stringify(result)+'\\n');
    }catch{
      process.stderr.write('vpn-trial-ready-notifications retry after transient failure\\n');
    }
    if(signal.aborted)break;
    try{await wait(5000,signal);}catch{
      if(!signal.aborted)throw Error('Trial ready notice loop delay failed');
    }
  }
}

async function main():Promise<void>{
  if(process.env.MNEBYVPN_ENV!=='production' ||
     process.env.MNEBYVPN_PURCHASE_NOTICE_WORKER!=='enabled')
    throw Error('Purchase notice worker is not explicitly activated');
  const url=process.env.DATABASE_URL;
  if(!url || !url.startsWith('postgresql://'))throw Error('Missing canonical PostgreSQL connection');
  const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:3000});
  const stop=new AbortController();
  process.on('SIGINT',()=>stop.abort());
  process.on('SIGTERM',()=>stop.abort());
  try{
    await pool.query('SELECT 1 FROM vpn_purchase_notifications LIMIT 1');
    await pool.query('SELECT 1 FROM vpn_trial_ready_notifications LIMIT 1');
    const token=notificationBotToken();
    await Promise.all([
      runVpnPurchaseNoticeLoop(new PgVpnPurchaseNoticeQueue(pool),
        new TelegramBotPurchaseSender(token),stop.signal),
      runVpnTrialReadyLoop(new PgVpnTrialReadyQueue(pool),
        new TelegramTrialReadySender(token),stop.signal),
    ]);
  }finally{await pool.end();}
}

if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]){
  main().catch(()=>{
    console.error('MNEBYVPN_PURCHASE_NOTICE_WORKER_FAILURE');
    process.exitCode=1;
  });
}
