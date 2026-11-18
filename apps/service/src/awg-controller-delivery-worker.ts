/**
 * Dedicated, opt-in, trusted AWG command-delivery process.
 *
 * Runs ONLY on a root-controlled central controller with the canonical DB.
 * No public listener, no client-profile issuance, no GitHub signing keys.
 * Importing this module has no side effects.
 */
import {createHash,createPrivateKey,createPublicKey,timingSafeEqual,
  type KeyObject} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {deliverNextAwgCommand} from '../../../packages/provisioning/src/awg-trusted-ssh-delivery.ts';

type DeliveryResult={status:'idle'}|{status:'acknowledged';outboxId:string};
type Deliver=()=>Promise<DeliveryResult>;
type Wait=(ms:number,signal:AbortSignal)=>Promise<void>;

export function trustedControllerKey(path:string,pinnedSha256:string):KeyObject {
  if(typeof process.getuid!=='function'||process.getuid()!==0)
    throw Error('AWG controller key access requires root');
  if(typeof path!=='string'||!path.startsWith('/')||path.length>1024||
     path.includes('\u0000')||
     !/^[a-f0-9]{64}$/.test(pinnedSha256))
    throw Error('Protected controller signing key and independent pin required');
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if(!stat||!stat.isFile()||stat.isSymbolicLink()||
     stat.uid!==0||(stat.mode&0o077)!==0)
    throw Error('Controller signing key is not a root-only regular file');
  const key=createPrivateKey(readFileSync(path));
  if(key.type!=='private'||key.asymmetricKeyType!=='ed25519')
    throw Error('Only Ed25519 controller signing key is accepted');
  const pub=createPublicKey(key).export({format:'der',type:'spki'});
  const fingerprint=createHash('sha256').update(pub).digest();
  if(!timingSafeEqual(fingerprint,Buffer.from(pinnedSha256,'hex')))
    throw Error('Controller signing key does not match independently approved pin');
  return key;
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
    await runAwgDeliveryLoop(
      ()=>deliverNextAwgCommand(db,signing,config),
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
