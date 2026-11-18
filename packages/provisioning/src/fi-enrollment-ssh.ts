/**
 * One-use, FI-only Nodekit registration over a reviewed SSH forced command.
 *
 * The controller (not a GitHub runner, public API or LLM) owns the signing
 * private key. The node owns its distinct private Ed25519 identity. Successful
 * enrollment is only a DB transition to 'enrolled', never a release.
 */
import {createHash,createPublicKey,type KeyObject} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {spawnSync,type SpawnSyncReturns} from 'node:child_process';
import type {Pool} from 'pg';
import {
  beginNodeEnrollment,completeNodeEnrollment,verifyNodeEnrollmentProof,
  type NodeEnrollmentChallenge,type NodeEnrollmentProof,
} from './node-enrollment.ts';

const NODE='fi-test-01';
const HOST='fi.mnebyvpn.site';
const ADDRESS='217.11.167.91';
// Independently reviewed SHA256 of FI's existing 44-byte Ed25519 node SPKI.
export const FI_NODE_IDENTITY_SHA256=
  'c3689b687e8888d15e3ece8e45cf7d01672b9dadb77b1963a7871ffd8e967ed9';
const NODE_SPki_PREFIX=Buffer.from('302a300506032b6570032100','hex');
const MAX_PROOF_BYTES=2048;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIG=/^[A-Za-z0-9_-]{86}$/;

export class FiEnrollmentError extends Error {}

export interface FiEnrollmentSshConfig {
  sshIdentityFile:string;
  pinnedKnownHostsFile:string;
  approvedNodePublicSpkiFile:string;
}
export type FiEnrollmentRunner=(
  binary:string,args:string[],
  options:{input:string;encoding:'utf8';timeout:number;maxBuffer:number},
)=>Pick<SpawnSyncReturns<string>,'status'|'error'|'stdout'|'stderr'>;

function rootFile(path:string):void{
  if(typeof path!=='string'||!path.startsWith('/')||path.length>1024||
     path.includes('\u0000')||path.includes('\r')||path.includes('\n')||
     resolve(path)!==path)
    throw new FiEnrollmentError('Canonical absolute protected controller file required');
  // File-mode checks are insufficient if an ancestor directory can be replaced
  // by an untrusted user. Reject non-root-owned or group/world-writable paths.
  let current=dirname(path);
  for(;;){
    const dir=lstatSync(current,{throwIfNoEntry:false});
    if(!dir||!dir.isDirectory()||dir.isSymbolicLink()||
       dir.uid!==0||(dir.mode&0o022)!==0)
      throw new FiEnrollmentError('Unsafe controller trust directory');
    if(current==='/')break;
    current=dirname(current);
  }
  const st=lstatSync(path,{throwIfNoEntry:false});
  if(!st||!st.isFile()||st.isSymbolicLink()||st.uid!==0||
     (st.mode&0o077)!==0)
    throw new FiEnrollmentError('Untrusted controller identity or host pin');
}

export function pinnedFiNodePublicSpki(path:string):string {
  rootFile(path);
  // Open once with O_NOFOLLOW; the inode verified below is also the inode
  // read, even if a leaf path is concurrently changed.
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let bytes:Buffer;
  try{
    const st=fstatSync(fd);
    if(!st.isFile()||st.uid!==0||(st.mode&0o077)!==0||st.size!==44)
      throw new FiEnrollmentError('Unsafe FI node public SPKI file');
    const data=Buffer.alloc(45);
    if(readSync(fd,data,0,data.length,0)!==44)
      throw new FiEnrollmentError('FI node public SPKI file changed while reading');
    bytes=data.subarray(0,44);
  }finally{closeSync(fd);}
  if(bytes.length!==44||!bytes.subarray(0,12).equals(NODE_SPki_PREFIX)||
     createHash('sha256').update(bytes).digest('hex')!==FI_NODE_IDENTITY_SHA256)
    throw new FiEnrollmentError('FI node public identity differs from approved inventory');
  const key=createPublicKey({key:bytes,format:'der',type:'spki'});
  if(key.asymmetricKeyType!=='ed25519')
    throw new FiEnrollmentError('FI identity is not Ed25519');
  return bytes.toString('base64url');
}

export function fiEnrollmentSshArgs(config:FiEnrollmentSshConfig):string[]{
  return [
    '-F','/dev/null','-T',
    '-o','BatchMode=yes','-o','IdentitiesOnly=yes',
    '-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no',
    '-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile='+config.pinnedKnownHostsFile,
    '-o','GlobalKnownHostsFile=/dev/null','-o','UpdateHostKeys=no',
    '-o','HostKeyAlias='+HOST,'-o','HostName='+ADDRESS,
    '-o','ForwardAgent=no','-o','ClearAllForwardings=yes',
    '-o','ControlMaster=no','-o','ProxyCommand=none',
    '-o','LogLevel=ERROR','-o','ConnectTimeout=8',
    '-i',config.sshIdentityFile,
    'root@'+HOST,
    // This MUST fail on a general shell account. Only an independently
    // reviewed authorized_keys forced-command identity may answer.
    'false',
  ];
}

export function parseFiEnrollmentProof(
  output:string,challenge:NodeEnrollmentChallenge,
):NodeEnrollmentProof{
  if(typeof output!=='string'||Buffer.byteLength(output)>MAX_PROOF_BYTES||
     !output.endsWith('\n')||output.slice(0,-1).includes('\n'))
    throw new FiEnrollmentError('Malformed FI node enrollment response');
  let value:unknown;
  try{value=JSON.parse(output);}catch{
    throw new FiEnrollmentError('FI node did not return a JSON possession proof');
  }
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw new FiEnrollmentError('FI node returned a non-object proof');
  // Nodekit emits sorted, compact JSON. Requiring exact canonical bytes also
  // rejects duplicate object keys that JSON.parse would otherwise overwrite.
  if(output!==JSON.stringify(value,Object.keys(value).sort())+'\n')
    throw new FiEnrollmentError('Noncanonical or duplicate FI node proof fields');
  const response=value as Record<string,unknown>;
  const fields=['challengeId','nodeId','endpointHost','publicSpki','nonce','signature'];
  if(Object.keys(response).length!==fields.length||
     fields.some(k=>!Object.prototype.hasOwnProperty.call(response,k))||
     response.challengeId!==challenge.challengeId||
     response.nodeId!==NODE||response.endpointHost!==HOST||
     response.publicSpki!==challenge.publicSpki||
     response.nonce!==challenge.nonce||
     typeof response.signature!=='string'||!SIG.test(response.signature)||
     !UUID.test(String(response.challengeId)))
    throw new FiEnrollmentError('FI possession proof mismatches approved challenge');
  const proof=response as unknown as NodeEnrollmentProof;
  if(!verifyNodeEnrollmentProof(proof))
    throw new FiEnrollmentError('FI node did not sign approved enrollment challenge');
  return proof;
}

/** One DB challenge -> one forced SSH command -> one DB consume.
 * Never retry an SSH failure with a new identity or auto-approve inventory.
 */
export async function enrollApprovedFiNode(
  db:Pick<Pool,'connect'>,
  signingKey:KeyObject,
  config:FiEnrollmentSshConfig,
  runner:FiEnrollmentRunner=spawnSync,
):Promise<{nodeId:'fi-test-01';state:'testing';published:false}>{
  if(typeof process.getuid!=='function'||process.getuid()!==0)
    throw new FiEnrollmentError('Enrollment must execute as root on the trusted controller');
  if(signingKey?.type!=='private'||signingKey.asymmetricKeyType!=='ed25519')
    throw new FiEnrollmentError('Root-protected Ed25519 controller signer required');
  // All protected local files are checked BEFORE creating a one-use challenge.
  rootFile(config.sshIdentityFile);
  rootFile(config.pinnedKnownHostsFile);
  const publicSpki=pinnedFiNodePublicSpki(config.approvedNodePublicSpkiFile);
  const challenge=await beginNodeEnrollment(db,{
    nodeId:NODE,endpointHost:HOST,publicSpki,
  },signingKey);
  // Date serialization preserves the canonical signed UTC challenge expiry.
  const payload=JSON.stringify(challenge)+'\n';
  if(Buffer.byteLength(payload)>2048)
    throw new FiEnrollmentError('Oversized FI enrollment challenge');
  let result:ReturnType<FiEnrollmentRunner>;
  try{
    result=runner('/usr/bin/ssh',fiEnrollmentSshArgs(config),{
      input:payload,encoding:'utf8',timeout:20_000,
      maxBuffer:MAX_PROOF_BYTES,
    });
  }catch{
    throw new FiEnrollmentError('Pinned FI enrollment transport unavailable');
  }
  if(result.error||result.status!==0)
    throw new FiEnrollmentError('FI enrollment challenge was not accepted');
  const proof=parseFiEnrollmentProof(result.stdout,challenge);
  const accepted=await completeNodeEnrollment(db,proof);
  if(accepted.nodeId!==NODE||accepted.state!=='testing')
    throw new FiEnrollmentError('Unexpected FI enrollment state');
  return {nodeId:NODE,state:'testing',published:false};
}
