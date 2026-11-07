/**
 * Explicit VPN provisioning daemon.
 * Panel provisioning is enabled ONLY after an operator has recorded real
 * pinned-version node expiry/partition evidence. This does not self-certify
 * a production data plane or modify the host's existing services.
 */
import {setTimeout as sleep} from 'node:timers/promises';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {PgBillingStore} from '../../../packages/billing/src/store.ts';
import {claimGuestVpnTrial,guestVpnState}
  from '../../../packages/provisioning/src/web-guest-trials.ts';
import {SignedXrayNodeApi} from '../../../packages/provisioning/src/xray-node.ts';
import {RemnawaveApi} from '../../../packages/provisioning/src/remnawave-api.ts';
import {RemnawaveProvisioningAdapter}
  from '../../../packages/provisioning/src/remnawave-adapter.ts';
import {PgOutboxDispatcher,type Product} from '../../../packages/provisioning/src/pg-worker.ts';
import {PgVpnExpiryReminderQueue,TelegramBotReminderSender,processVpnExpiryReminders,
  type ReminderSender} from '../../../packages/notifications/src/vpn-expiry.ts';

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

/** Runs independently from 5-second provisioning, never holds the node worker
 * hostage during Bot API rate limits/outages. One sweep on boot and per minute.
 */
export async function runVpnExpiryReminderLoop(
  queue:PgVpnExpiryReminderQueue,sender:ReminderSender,signal:AbortSignal,
  wait:(ms:number,signal:AbortSignal)=>Promise<void>=
    async(ms,s)=>{await sleep(ms,undefined,{signal:s});},
):Promise<void>{
  while(!signal.aborted){
    try{
      const result=await processVpnExpiryReminders(queue,sender);
      if(Object.values(result).some(Boolean)){
        process.stdout.write('vpn-expiry-notifications '+JSON.stringify(result)+'\n');
      }
    }catch{
      // No email addresses, token, Telegram IDs or subscription keys in logs.
      process.stderr.write('vpn-expiry-notifications retry after transient failure\n');
    }
    if(signal.aborted)break;
    try{await wait(60_000,signal);}catch{
      if(!signal.aborted)throw Error('Notification worker delay failed');
    }
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
  const actualNode=process.env.MNEBYVPN_NODE_WORKER==='enabled';
  // Real WireGuard-only Xray node enforces expiry in its own process.
  // Panel-only Remnawave stays fail-closed as a fallback.
  const node=actualNode
    ?new SignedXrayNodeApi(readFileSync(configured('VPN_NODE_KEY_FILE'),'utf8').trim())
    :null;
  const adapter=node??new RemnawaveProvisioningAdapter(new RemnawaveApi({
    panelUrl:configured('REMNAWAVE_API_URL'),
    apiToken:configured('REMNAWAVE_API_TOKEN'),
    subscriptionOrigin:configured('VPN_SUBSCRIPTION_ORIGIN'),
    squadUuids:configured('REMNAWAVE_SQUAD_UUIDS').split(',').map(x=>x.trim()),
  }));
  const profileToken=process.env.VPN_WORKER_PROFILE_TOKEN??'';
  if(node&&!/^[a-f0-9]{64}$/i.test(profileToken))
    throw Error('VPN_WORKER_PROFILE_TOKEN is required in node mode');
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
    const billing=new PgBillingStore(pool);
    const health=createServer(async(req,res)=>{
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Type','application/json');
      if((req.url==='/guest-trial'||req.url==='/guest-status')&&
         req.method==='POST'&&node){
        const authorization=req.headers.authorization;
        const supplied=typeof authorization==='string'&&
          authorization.startsWith('Bearer ')?authorization.slice(7):'';
        const expected=Buffer.from(profileToken,'utf8');
        const actual=Buffer.from(supplied,'utf8');
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){
          res.writeHead(401).end('{"code":"UNAUTHORIZED"}');return;
        }
        try{
          let raw='';
          for await(const chunk of req){
            raw+=String(chunk);
            if(raw.length>256)throw Error('Oversized website trial request');
          }
          const body:unknown=JSON.parse(raw);
          const token=(body as {guestToken?:unknown})?.guestToken;
          if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))
            throw Error('Invalid browser trial cookie');
          if(req.url==='/guest-trial'){
            const status=await claimGuestVpnTrial(pool,token);
            res.writeHead(200).end(JSON.stringify({status}));return;
          }
          const result=await guestVpnState(pool,token,profileToken);
          res.writeHead(200).end(JSON.stringify(result));return;
        }catch{
          res.writeHead(503).end('{"code":"GUEST_TRIAL_RETRY_LATER"}');return;
        }
      }
      if(req.url==='/profile'&&req.method==='POST'&&node){
        const authorization=req.headers.authorization;
        const supplied=typeof authorization==='string'&&
          authorization.startsWith('Bearer ')?authorization.slice(7):'';
        const expected=Buffer.from(profileToken,'utf8');
        const actual=Buffer.from(supplied,'utf8');
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){
          res.writeHead(401).end('{"code":"UNAUTHORIZED"}');return;
        }
        try{
          let raw='';
          for await(const chunk of req){
            raw+=String(chunk);
            if(raw.length>512)throw Error('Oversized profile request');
          }
          const input:unknown=JSON.parse(raw);
          const userId=(input as {telegramUserId?:unknown})?.telegramUserId;
          const requestedId=(input as {entitlementId?:unknown})?.entitlementId;
          const isTelegram=typeof userId==='number'&&Number.isSafeInteger(userId)&&userId>0;
          if(!isTelegram && userId!==undefined)
            throw Error('Invalid Telegram actor');
          if(!isTelegram&&requestedId===undefined)
            throw Error('Guest lookup requires entitlement ID');
          if(requestedId!==undefined&&
            (typeof requestedId!=='string'||
             !/^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(requestedId)))
            throw Error('Invalid requested entitlement');
          const allowed=isTelegram
            ?await billing.confirmedVpnProfile(userId as number)
            :await (async()=>{
                // Also support authenticated Yandex-only account profiles.
                // The caller is a loopback-only server-to-server bridge with
                // a private bearer secret. The public /sub route separately
                // verifies the opaque link and its active entitlement owner.
                const result=await pool.query(
                  `SELECT e.id,e.revision,e.expires_at FROM entitlements e
                   JOIN provisioning_state p ON p.entitlement_id=e.id AND p.adapter='vpn'
                   WHERE e.id=$1 AND e.product='vpn' AND e.state='ACTIVE'
                     AND e.expires_at>clock_timestamp()
                     AND p.applied_revision=e.revision
                     AND p.last_observed_at IS NOT NULL LIMIT 1`,
                  [requestedId]);
                if(result.rows.length!==1)return null;
                return {entitlementId:String(result.rows[0].id),
                  revision:Number(result.rows[0].revision),
                  expiresAt:result.rows[0].expires_at as Date};
              })();
          // A previously shared subscription URL must not accidentally reveal
          // another entitlement belonging to the same Telegram account.
          const profile=allowed&&
            (requestedId===undefined||allowed.entitlementId===requestedId)
            ?await node.profileFor(
              allowed.entitlementId,allowed.revision,allowed.expiresAt):null;
          res.writeHead(200).end(JSON.stringify({profile}));return;
        }catch{
          res.writeHead(503).end('{"code":"RETRY_LATER"}');return;
        }
      }
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
      // A proactive Bot API send requires the *bot token*. It is separate from
      // the webhook secret and must be provided only in private runtime-vpn.env.
      const remindersEnabled=process.env.VPN_EXPIRY_REMINDERS_ENABLED==='yes';
      const reminders=remindersEnabled
        ?new TelegramBotReminderSender(configured('TELEGRAM_BOT_TOKEN')):null;
      const notificationLoop=reminders?runVpnExpiryReminderLoop(
        new PgVpnExpiryReminderQueue(pool),reminders,abort.signal):null;
      try{
        await runVpnWorker(new PgOutboxDispatcher(pool,{vpn:adapter}),
          abort.signal,undefined,()=>{lastCycleSuccess=Date.now();});
      }finally{
        abort.abort();
        if(notificationLoop)await notificationLoop;
      }
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
