/**
 * Explicitly started operator alert service; pending payment incidents survive
 * process crashes and Telegram outages in PostgreSQL.
 * Offline-only until real payment infrastructure and operations are approved.
 */
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {PgBillingStore} from '../../../packages/billing/src/store.ts';
import {deliverPaymentIncidentAlerts} from '../../../packages/billing/src/payment-alerts.ts';

export async function startOfflinePaymentAlerts(
 dbUrl:string,botToken:string,operatorChatId:number,signal:AbortSignal,
):Promise<void> {
 if(process.env.MNEBYVPN_ENV!=='offline-test')
   throw new Error('No production payment alert transport configured');
 if(!dbUrl||!botToken||!Number.isSafeInteger(operatorChatId)||operatorChatId<=0)
   throw new Error('Missing alert operator configuration');
 const pool=new Pool({connectionString:dbUrl,max:2,connectionTimeoutMillis:2500});
 const db=new PgBillingStore(pool);
 const sender={sendMessage:async(chatId:number,text:string)=>{
   const result=await fetch('https://api.telegram.org/bot'+botToken+'/sendMessage',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:chatId,text}),
    signal:AbortSignal.timeout(7000),
   });
   if(!result.ok)throw new Error('ALERT_PROVIDER_FAILED');
   const data=await result.json() as {ok?:boolean};
   if(data.ok!==true)throw new Error('ALERT_PROVIDER_REJECTED');
 }};
 try{
   while(!signal.aborted){
     try{
       await deliverPaymentIncidentAlerts(db,sender,operatorChatId);
     }catch(error){
       // No payloads, secrets or user data in worker error logs.
       process.stderr.write('MNEBYVPN payment-alert delivery retry required\n');
     }
     try{await delay(15000,undefined,{signal});}catch{if(!signal.aborted)throw Error('Alert scheduler failed');}
   }
 } finally {await pool.end();}
}
if(process.env.MNEBYVPN_INCIDENT_ALERTS==='offline-test'){
 const ctrl=new AbortController();
 process.on('SIGINT',()=>ctrl.abort());
 process.on('SIGTERM',()=>ctrl.abort());
 const url=process.env.DATABASE_URL;
 const token=process.env.TELEGRAM_BOT_TOKEN;
 const id=Number(process.env.PAYMENT_ALERT_CHAT_ID);
 if(!url||!token)throw new Error('Alert worker configuration missing');
 await startOfflinePaymentAlerts(url,token,id,ctrl.signal);
}
