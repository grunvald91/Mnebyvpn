/**
 * Isolated purchased-VPN Telegram notices. Does not initialize Xray, VPN
 * provisioning, public ports, or payment settlement. Production must supply
 * the pre-existing bot secret and canonical PostgreSQL connection.
 */
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {PgVpnPurchaseNoticeQueue,TelegramBotPurchaseSender} from '../../../packages/notifications/src/vpn-purchase.ts';
import {notificationBotToken,runVpnPurchaseNoticeLoop} from './vpn-provisioning-worker.ts';

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
    const sender=new TelegramBotPurchaseSender(notificationBotToken());
    await runVpnPurchaseNoticeLoop(new PgVpnPurchaseNoticeQueue(pool),sender,stop.signal);
  }finally{await pool.end();}
}

if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]){
  main().catch(()=>{
    console.error('MNEBYVPN_PURCHASE_NOTICE_WORKER_FAILURE');
    process.exitCode=1;
  });
}
