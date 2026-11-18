/**
 * Trusted controller-only transport to a reviewed AWG3.1 Nodekit VPS.
 *
 * No HTTP handlers, no passwords, no GitHub Actions signing. The worker's SSH
 * key stays on the protected controller; the node sees ONLY a signed lease
 * and returns a signed node receipt, verified by awg-controller-outbox.
 *
 * Currently FI-only until multi-country IPAM and host-key enrollment.
 */
import {spawnSync,type SpawnSyncReturns} from 'node:child_process';
import {lstatSync} from 'node:fs';
import type {Pool} from 'pg';
import type {KeyObject} from 'node:crypto';
import {
  claimAwgCommand,acknowledgeAwgCommand,
  type NodeAwgReceipt,
} from './awg-controller-outbox.ts';
import type {SignedAwgLease} from './awg-controller-grants.ts';

const NODE='fi-test-01';
const SERVER='217.11.167.91';
const HOST_ALIAS='fi.mnebyvpn.site';
const MAX_RESPONSE=16*1024;
const MAX_COMMAND=4096;
const REMOTE_SCRIPT=[
  'set -eu',
  'umask 077',
  'tmp=$(mktemp /run/nodekit-awg-delivery.XXXXXXXX)',
  'trap \'rm -f "$tmp"\' EXIT',
  'cat > "$tmp"',
  '/usr/bin/python3 /opt/mnebyvpn-nodekit/awg_peer_grants.py',
  '--node-id fi-test-01 --mode apply --command "$tmp"',
].join('; ');

export class AwgTransportError extends Error {}

export type TrustedSshConfig={
  sshIdentityFile:string;
  pinnedKnownHostsFile:string;
};
type Run=(executable:string,args:string[],options:{
  input:string;encoding:'utf8';timeout:number;maxBuffer:number;
})=>Pick<SpawnSyncReturns<string>,'status'|'error'|'stdout'|'stderr'>;

function safeRootFile(path:string):void {
  if(typeof path!=='string'||!path.startsWith('/')||
     path.includes('\u0000')||path.length>1024){
    throw new AwgTransportError('A protected absolute controller file is required');
  }
  const meta=lstatSync(path,{throwIfNoEntry:false});
  if(!meta||!meta.isFile()||meta.isSymbolicLink()||
     meta.uid!==0||(meta.mode&0o077)!==0){
    throw new AwgTransportError('Untrusted controller SSH key or pinned host file');
  }
}

export function awgSshArgs(config:TrustedSshConfig):string[]{
  safeRootFile(config.sshIdentityFile);
  safeRootFile(config.pinnedKnownHostsFile);
  return [
    '-T','-F','/dev/null',
    '-o','BatchMode=yes','-o','IdentitiesOnly=yes',
    '-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no',
    '-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile='+config.pinnedKnownHostsFile,
    '-o','HostKeyAlias='+HOST_ALIAS,
    '-o','ControlMaster=no','-o','ForwardAgent=no',
    '-o','ClearAllForwardings=yes',
    '-o','ConnectTimeout=8',
    '-i',config.sshIdentityFile,
    'root@'+SERVER,REMOTE_SCRIPT,
  ];
}
function assertEnvelope(command:SignedAwgLease):void{
  if(!command||command.nodeId!==NODE||
     !['grant','revoke'].includes(command.op)||
     typeof command.signature!=='string'||
     !/^[A-Za-z0-9_-]{86}$/.test(command.signature)){
    throw new AwgTransportError('Unapproved AWG command identity');
  }
}

export function parseAwgNodeReceipt(output:string,command:SignedAwgLease):NodeAwgReceipt{
  if(typeof output!=='string'||output.length>MAX_RESPONSE)
    throw new AwgTransportError('Invalid AWG node response length');
  let parsed:unknown;
  try{
    const lines=output.trim().split('\n');
    if(lines.length!==1)throw new Error('Unexpected output');
    parsed=JSON.parse(lines[0]);
  }catch{
    throw new AwgTransportError('Node did not return a valid JSON receipt');
  }
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))
    throw new AwgTransportError('Non-object node response');
  const obj=parsed as Record<string,unknown>;
  const receipt=obj.node_receipt;
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))
    throw new AwgTransportError('Node did not sign its actual peer application');
  const r=receipt as Record<string,unknown>;
  const fields=['nodeId','op','entitlementId','revision','commandSha256',
                'appliedAt','nonce','signature'];
  if(Object.keys(r).length!==fields.length||
     fields.some(f=>!Object.prototype.hasOwnProperty.call(r,f))||
     r.nodeId!==command.nodeId||r.op!==command.op||
     r.entitlementId!==command.entitlementId||
     r.revision!==command.revision||
     obj.signed_command_verified!==true||obj.active!==true||
     typeof r.signature!=='string'||!/^[a-zA-Z0-9_-]{86}$/.test(r.signature)){
    throw new AwgTransportError('Mismatch between signed command and node receipt');
  }
  return r as unknown as NodeAwgReceipt;
}

/** One claim -> pinned-host SSH -> signed receipt -> transactional ACK.
 * An error NEVER marks an outbox command as applied; the 40s claim window
 * expires and the central controller must issue a newer revision.
 */
export async function deliverNextAwgCommand(
  db:Pick<Pool,'connect'>,
  controllerSigningKey:KeyObject,
  config:TrustedSshConfig,
  now=new Date(),
  runner:Run=spawnSync,
):Promise<{status:'idle'}|{status:'acknowledged';outboxId:string}>{
  // Check root-owned SSH identity and host pin BEFORE claiming one-use work.
  const args=awgSshArgs(config);
  const record=await claimAwgCommand(db,controllerSigningKey,now);
  if(!record)return {status:'idle'};
  assertEnvelope(record.command);
  const serialized=JSON.stringify(record.command);
  if(Buffer.byteLength(serialized,'utf8')>MAX_COMMAND)
    throw new AwgTransportError('Oversize signed AWG command');
  let result:ReturnType<Run>;
  try{
    result=runner('/usr/bin/ssh',args,{
      input:serialized+'\n',encoding:'utf8',timeout:20_000,
      maxBuffer:MAX_RESPONSE,
    });
  }catch{
    throw new AwgTransportError('Pinned Nodekit SSH transport failed');
  }
  if(result.error||result.status!==0)
    throw new AwgTransportError('AWG node refused signed command');
  const receipt=parseAwgNodeReceipt(result.stdout,record.command);
  // The receipt is not trusted until the controller verifies its signature
  // against the pinned node identity and the CURRENT entitlement revision.
  await acknowledgeAwgCommand(db,{
    outboxId:record.outboxId,receipt,
  },new Date());
  return {status:'acknowledged',outboxId:record.outboxId};
}
