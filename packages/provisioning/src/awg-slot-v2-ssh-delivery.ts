/**
 * Private V2 controller -> FI Nodekit, over pinned root-only SSH only.
 *
 * No public HTTP entrypoint or background runner is instantiated here.
 * CI injects a deterministic SSH simulator; no real customer network access.
 */
import {spawnSync,type SpawnSyncReturns} from 'node:child_process';
import {lstatSync} from 'node:fs';
import type {Pool} from 'pg';
import type {KeyObject} from 'node:crypto';
import {
  claimOwnerAwgSlotCommand,acknowledgeOwnerAwgSlotCommand,
} from './awg-slot-v2-outbox.ts';
import type {
  AwgSlotLeaseV2,AwgSlotReceiptV2,
} from './awg-device-lease-v2.ts';

const NODE='fi-test-01';
const ADDRESS='217.11.167.91';
const HOST_ALIAS='fi.mnebyvpn.site';
const MAX_COMMAND=4096;
const MAX_RESPONSE=16*1024;
const SIG=/^[A-Za-z0-9_-]{86}$/;
const HEX=/^[0-9a-f]{64}$/;

export class AwgSlotTransportError extends Error {}
export type AwgSlotSshConfig={
  sshIdentityFile:string;pinnedKnownHostsFile:string;
};
type Runner=(executable:string,args:string[],options:{
  input:string;encoding:'utf8';timeout:number;maxBuffer:number;
})=>Pick<SpawnSyncReturns<string>,'status'|'error'|'stdout'|'stderr'>;

export const awgSlotRemoteApplyScript=[
  'set -eu',
  'umask 077',
  'tmp=$(mktemp /run/nodekit-awg-v2.XXXXXXXX)',
  "trap 'rm -f \"$tmp\"' EXIT",
  'cat > "$tmp"',
  '/usr/bin/python3 /opt/mnebyvpn-nodekit/awg_slot_runtime.py '+
    '--node-id fi-test-01 --mode apply --command "$tmp"',
].join('; ');

function rootOnly(path:string){
  if(typeof path!=='string'||!path.startsWith('/')||
     path.includes('\u0000')||path.length>1024)
    throw new AwgSlotTransportError('Pinned absolute controller identity required');
  const info=lstatSync(path,{throwIfNoEntry:false});
  if(!info||!info.isFile()||info.isSymbolicLink()||
     info.uid!==0||(info.mode&0o077)!==0)
    throw new AwgSlotTransportError('Untrusted controller SSH identity or known hosts');
}
export function awgSlotSshArgs(config:AwgSlotSshConfig):string[]{
  rootOnly(config.sshIdentityFile);
  rootOnly(config.pinnedKnownHostsFile);
  return [
    '-T','-F','/dev/null','-o','BatchMode=yes','-o','IdentitiesOnly=yes',
    '-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no',
    '-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile='+config.pinnedKnownHostsFile,
    '-o','HostKeyAlias='+HOST_ALIAS,
    '-o','ControlMaster=no','-o','ForwardAgent=no',
    '-o','ClearAllForwardings=yes','-o','ConnectTimeout=8',
    '-i',config.sshIdentityFile,'root@'+ADDRESS,
    awgSlotRemoteApplyScript,
  ];
}

export function parseAwgSlotNodeReceipt(
  output:string,command:AwgSlotLeaseV2,
):AwgSlotReceiptV2{
  if(typeof output!=='string'||output.length>MAX_RESPONSE||
     output.includes('\r'))
    throw new AwgSlotTransportError('Invalid V2 node response length/content');
  let parsed:unknown;
  try{
    const lines=output.trim().split('\n');
    if(lines.length!==1)throw new Error('Multiple result lines');
    parsed=JSON.parse(lines[0]);
  }catch{throw new AwgSlotTransportError('Node did not return JSON-only V2 receipt');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
    throw new AwgSlotTransportError('Unexpected signed V2 node response');
  const object=parsed as Record<string,unknown>;
  if(object.active!==true||object.signed_command_verified!==true||
     object.published!==false||Object.keys(object).length!==4)
    throw new AwgSlotTransportError('V2 server did not verify/apply the peer');
  const receipt=object.node_receipt;
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))
    throw new AwgSlotTransportError('Missing signed V2 per-slot receipt');
  const r=receipt as Record<string,unknown>;
  const fields=['nodeId','op','entitlementId','slotNumber','revision',
    'commandSha256','appliedAt','nonce','signature'];
  if(Object.keys(r).length!==fields.length||
     fields.some(x=>!Object.prototype.hasOwnProperty.call(r,x))||
     r.nodeId!==NODE||r.nodeId!==command.nodeId||
     r.op!==command.op||r.entitlementId!==command.entitlementId||
     r.slotNumber!==command.slotNumber||r.revision!==command.revision||
     typeof r.commandSha256!=='string'||!HEX.test(r.commandSha256)||
     typeof r.nonce!=='string'||!HEX.test(r.nonce)||
     typeof r.signature!=='string'||!SIG.test(r.signature)||
     typeof r.appliedAt!=='string')
    throw new AwgSlotTransportError('Signed V2 receipt does not bind exact slot');
  return r as unknown as AwgSlotReceiptV2;
}

export async function deliverNextAwgSlotCommand(
  db:Pick<Pool,'connect'>,controllerKey:KeyObject,
  config:AwgSlotSshConfig,now=new Date(),runner:Runner=spawnSync,
):Promise<{status:'idle'}|{status:'acknowledged';outboxId:string}>{
  // Validate local root-only identity BEFORE claiming a short-lived command.
  const args=awgSlotSshArgs(config);
  const record=await claimOwnerAwgSlotCommand(db,controllerKey,now);
  if(!record)return {status:'idle'};
  const cmd=record.command;
  if(cmd.nodeId!==NODE)
    throw new AwgSlotTransportError('Unapproved V2 node target');
  const serialized=JSON.stringify(cmd);
  if(Buffer.byteLength(serialized,'utf8')>MAX_COMMAND)
    throw new AwgSlotTransportError('Oversized signed V2 command');
  let response:ReturnType<Runner>;
  try{
    response=runner('/usr/bin/ssh',args,{
      input:serialized+'\n',encoding:'utf8',timeout:20_000,
      maxBuffer:MAX_RESPONSE,
    });
  }catch{throw new AwgSlotTransportError('Pinned V2 SSH transport failure');}
  if(response.error||response.status!==0)
    throw new AwgSlotTransportError('AWG V2 node refused signed command');
  const receipt=parseAwgSlotNodeReceipt(response.stdout,cmd);
  // No caller-supplied "applied" boolean is trusted as an ACK.
  // The controller validates the pinned node's Ed25519 signature and
  // current paid billing+slot identity before committing applied state.
  await acknowledgeOwnerAwgSlotCommand(
    db,{outboxId:record.outboxId,receipt},controllerKey,new Date());
  return {status:'acknowledged',outboxId:record.outboxId};
}
