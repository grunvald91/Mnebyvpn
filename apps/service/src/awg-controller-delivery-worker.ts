/**
 * Dedicated, opt-in, trusted AWG command-delivery process.
 *
 * Runs ONLY on a root-controlled central controller with the canonical DB.
 * No public listener, no client-profile issuance, no GitHub signing keys.
 * Importing this module has no side effects.
 */
import {createHash,createPrivateKey,createPublicKey,timingSafeEqual,
  type KeyObject} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {deliverNextAwgCommand} from '../../../packages/provisioning/src/awg-trusted-ssh-delivery.ts';
import {deliverNextAwgSlotCommand}
  from '../../../packages/provisioning/src/awg-slot-v2-ssh-delivery.ts';
import {stageDueOfflineAwgMaintenance} from '../../../packages/provisioning/src/awg-offline-maintenance.ts';
import {stageNextFiAwgDevice,enqueueFiAwgActiveSubscriptions}
  from '../../../packages/provisioning/src/awg-device-registration-worker.ts';

type DeliveryResult={status:'idle'}|{status:'acknowledged';outboxId:string};
type Deliver=()=>Promise<DeliveryResult>;
type Wait=(ms:number,signal:AbortSignal)=>Promise<void>;

/**
 * Read the trusted RU188 controller signer from the SAME verified file
 * descriptor. This avoids the previous lstat -> readFile path-swap gap.
 * Neither a parent directory nor the private key may be caller writable.
 */
export function trustedControllerKey(path:string,pinnedSha256:string):KeyObject {
  if(typeof process.getuid!=='function'||process.getuid()!==0)
    throw Error('AWG controller key access requires root');
  if(typeof path!=='string'||!path.startsWith('/')||path.length>1024||
     path.includes('\u0000')||resolve(path)!==path||
     !/^[a-f0-9]{64}$/.test(pinnedSha256))
    throw Error('Protected controller signing key and independent pin required');
  let parent=dirname(path);
  for(;;){
    const dir=lstatSync(parent,{throwIfNoEntry:false});
    if(!dir||!dir.isDirectory()||dir.isSymbolicLink()||
       dir.uid!==0||(dir.mode&0o022)!==0)
      throw Error('Untrusted controller signing-key ancestry');
    if(parent==='/')break;
    parent=dirname(parent);
  }
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let raw:Buffer;
  try{
    const meta=fstatSync(fd);
    if(!meta.isFile()||meta.uid!==0||(meta.mode&0o077)!==0||
       meta.size<1||meta.size>8192)
      throw Error('Controller signing key is not a bounded root-only file');
    const data=Buffer.alloc(meta.size+1);
    if(readSync(fd,data,0,data.length,0)!==meta.size)
      throw Error('Controller signing key changed while reading');
    raw=data.subarray(0,meta.size);
  }finally{closeSync(fd);}
  try{
    const key=createPrivateKey(raw);
    if(key.type!=='private'||key.asymmetricKeyType!=='ed25519')
      throw Error('Only Ed25519 controller signing key is accepted');
    const pub=createPublicKey(key).export({format:'der',type:'spki'});
    const fingerprint=createHash('sha256').update(pub).digest();
    if(!timingSafeEqual(fingerprint,Buffer.from(pinnedSha256,'hex')))
      throw Error('Controller signing key does not match independently approved pin');
    return key;
  }finally{raw.fill(0);}
}

export async function runAwgDeliveryLoop(
  deliver:Deliver,signal:AbortSignal,
  wait:Wait=async(ms,s)=>{await pause(ms,undefined,{signal:s});},
  onCycle?:(result:'idle'|'acknowledged'|'error')=>void,
):Promise<void>{
  let consecutiveFailures=0;
  while(!signal.aborted){
    try{
      const result=await deliver();
      consecutiveFailures=0;
      onCycle?.(result.status);
    }catch{
      // Never log SSH stderr, a command, public keys or billing identifiers.
      onCycle?.('error');
      if(++consecutiveFailures>=3)
        throw Error('Repeated trusted AWG delivery failures');
    }
    if(signal.aborted)break;
    try{await wait(5_000,signal);}
    catch{if(!signal.aborted)throw Error('AWG delivery scheduling failed');}
  }
}

/** Guarded, serial V1 then V2 delivery; never reaches V2 when disabled. */
export async function deliverAwgCycle(
  legacy:Deliver,ownerV2:Deliver,v2Enabled:boolean,
):Promise<DeliveryResult>{
  const v1=await legacy();
  if(!v2Enabled)return v1;
  const slots=await ownerV2();
  return slots.status==='acknowledged'?slots:v1;
}

async function main():Promise<void>{
  if(process.env.MNEBYVPN_ENV!=='production'||
     process.env.MNEBYVPN_AWG_DELIVERY_WORKER!=='enabled')
    throw Error('Trusted AWG delivery is disabled');
  const url=process.env.DATABASE_URL??'';
  if(!/^postgres(?:ql)?:\/\//.test(url))
    throw Error('Canonical PostgreSQL controller URL required');
  const signing=trustedControllerKey(
    process.env.AWG_CONTROLLER_SIGNING_KEY_FILE??'',
    process.env.AWG_CONTROLLER_PUBLIC_SHA256??'',
  );
  const config={
    sshIdentityFile:process.env.AWG_CONTROLLER_SSH_IDENTITY_FILE??'',
    pinnedKnownHostsFile:process.env.AWG_CONTROLLER_SSH_KNOWN_HOSTS_FILE??'',
  };
  // RU188 owns one additional peer identity per canonical entitlement,
  // NOT a second subscription, token, purchase or access controller.
  const subscriptionIdentityRoot=process.env.AWG_INCY_SUBSCRIPTION_SEED??'';
  // Independent opt-in for private owner V2 delivery; default strictly OFF.
  // No V2 command is automatically staged by this worker.
  const ownerV2Delivery=process.env.MNEBYVPN_AWG_SLOT_V2_DELIVERY==='enabled';
  const db=new Pool({connectionString:url,max:1,connectionTimeoutMillis:3000,
                     idleTimeoutMillis:12000});
  const abort=new AbortController();
  const stop=()=>abort.abort();
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
    // A merged migration is NOT proof that the production schema was applied.
    const checked=await db.query(
      "SELECT to_regclass('public.vpn_awg_command_outbox')::text AS outbox, "+
      "to_regclass('public.vpn_node_enrollment_inventory')::text AS inventory",
    );
    if(!checked.rows[0]?.outbox||!checked.rows[0]?.inventory)
      throw Error('AWG outbox and enrolled-node schema are not ready');
    if(ownerV2Delivery){
      const slotTables=await db.query(
        "SELECT to_regclass('public.owner_vpn_awg_slot_allocations')::text AS allocation, "+
        "to_regclass('public.owner_vpn_awg_slot_command_outbox')::text AS outbox"
      );
      if(!slotTables.rows[0]?.allocation||!slotTables.rows[0]?.outbox)
        throw Error('Private AWG V2 slot delivery migration 0146 missing');
    }
    // Autonomous grant refresh/revoke is independent of client connections.
    // Keep deliveries moving even if a maintenance cycle fails; the next
    // cycle retries while the FI node keeps honoring its local signed ledger.
    let nextMaintenanceAt=0;
    let nextSubscriptionEnrollmentAt=0;
    await runAwgDeliveryLoop(
      async()=>{
        const current=Date.now();
        if(current>=nextMaintenanceAt){
          nextMaintenanceAt=current+60_000;
          try{
            const result=await stageDueOfflineAwgMaintenance(db,signing,new Date(current));
            if(result.failed>0)process.stderr.write('AWG_OFFLINE_MAINTENANCE_PARTIAL\n');
          }catch{
            process.stderr.write('AWG_OFFLINE_MAINTENANCE_RETRY\n');
          }
        }
        // All already paid/trial-entitled subscribers are enrolled for FI
        // asynchronously. Connections and /sub requests never call RU188.
        if(subscriptionIdentityRoot&&current>=nextSubscriptionEnrollmentAt){
          nextSubscriptionEnrollmentAt=current+60_000;
          try{
            const queued=await enqueueFiAwgActiveSubscriptions(
              db,subscriptionIdentityRoot,12);
            if(queued>0)process.stdout.write('FI_AWG_SUBSCRIPTION_ENROLLMENT_QUEUED\n');
          }catch{
            process.stderr.write('FI_AWG_SUBSCRIPTION_ENROLLMENT_RETRY\n');
          }
        }
        // User-submitted PUBLIC keys enter the existing signed grant
        // outbox asynchronously, never during a client connection or GET.
        // The same dormant worker and FI client release gates apply.
        try{
          const device=await stageNextFiAwgDevice(db,signing,new Date(current));
          if(device.status==='staged')
            process.stdout.write('FI_AWG_DEVICE_GRANT_STAGED\\n');
          if(device.status==='blocked')
            process.stderr.write('FI_AWG_DEVICE_REQUEST_BLOCKED\\n');
        }catch{
          // Queue failure does not suppress an already-approved grant revoke.
          process.stderr.write('FI_AWG_DEVICE_QUEUE_RETRY\\n');
        }
        return deliverAwgCycle(
          ()=>deliverNextAwgCommand(db,signing,config),
          ()=>deliverNextAwgSlotCommand(db,signing,config),
          ownerV2Delivery,
        );
      },
      abort.signal,undefined,(status)=>{
        if(status==='acknowledged')process.stdout.write('AWG_DELIVERY_ACKNOWLEDGED\n');
        if(status==='error')process.stderr.write('AWG_DELIVERY_FAILED\n');
      },
    );
  }finally{
    process.off('SIGTERM',stop);process.off('SIGINT',stop);
    await db.end();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  await main().catch(()=>{
    process.stderr.write('AWG_CONTROLLER_WORKER_STOPPED\n');
    process.exitCode=1;
  });
