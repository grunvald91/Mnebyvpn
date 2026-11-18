#!/usr/bin/env node
/**
 * Trusted-controller cryptographic bootstrap (local only, no network).
 *
 * Run as root on the EXISTING controller 188.120.254.223. Creates separate
 * Ed25519 controller signer and SSH enrollment identities under a private
 * root-only directory. NEVER approves a key, connects to FI, accesses DB,
 * installs a service, changes a release flag, or provisions a subscriber.
 */
import {
  createHash,createPrivateKey,createPublicKey,generateKeyPairSync,
} from 'node:crypto';
import {
  chmodSync,closeSync,constants,existsSync,fsyncSync,fstatSync,lstatSync,
  mkdirSync,mkdtempSync,openSync,readFileSync,readSync,renameSync,rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {networkInterfaces} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const FI_SHA='c3689b687e8888d15e3ece8e45cf7d01672b9dadb77b1963a7871ffd8e967ed9';
const PREFIX=Buffer.from('302a300506032b6570032100','hex');
const DEFAULT_ROOT='/root/mnebyvpn-controller';
const CONTROLLER188='188.120.254.223';
const EXISTING_CONTROLLER_ROOT='/opt/mnebyvpn';
const SHA=/^[a-f0-9]{64}$/;
const SSH_FINGERPRINT=/^SHA256:[A-Za-z0-9+/]{43}$/;
const FILES=Object.freeze({
  signer:'controller-signing-key.pem',
  public:'controller-public.spki',
  sshPrivate:'fi-enrollment-ssh',
  sshPublic:'fi-enrollment-ssh.pub',
  manifest:'bootstrap-manifest.json',
});
export class ControllerBootstrapError extends Error {}

function requireRoot(){
  if(typeof process.getuid!=='function'||process.getuid()!==0)
    throw new ControllerBootstrapError('Only root on the trusted controller may bootstrap keys');
}
function directory(path,{privateDir=false}={}){
  const st=lstatSync(path,{throwIfNoEntry:false});
  if(!st||!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||
     (st.mode&(privateDir?0o077:0o022))!==0)
    throw new ControllerBootstrapError('Untrusted controller directory or ancestor');
}
function safeRoot(path,{existing=false}={}){
  if(typeof path!=='string'||!path.startsWith('/')||
     resolve(path)!==path||path==='/'||path.length>1024||
     path.includes('\n')||path.includes('\0'))
    throw new ControllerBootstrapError('Canonical absolute controller root is required');
  let parent=dirname(path);
  for(;;){
    directory(parent);
    if(parent==='/')break;
    parent=dirname(parent);
  }
  if(existing)directory(path,{privateDir:true});
  else if(existsSync(path)||lstatSync(path,{throwIfNoEntry:false}))
    throw new ControllerBootstrapError('Existing controller material must never be rotated');
  return path;
}

function privateRead(path,maxBytes){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const st=fstatSync(fd);
    if(!st.isFile()||st.uid!==0||(st.mode&0o077)!==0||
       st.size<1||st.size>maxBytes)
      throw new ControllerBootstrapError('Unsafe root-only controller asset');
    const out=Buffer.alloc(st.size+1);
    const len=readSync(fd,out,0,out.length,0);
    if(len!==st.size)
      throw new ControllerBootstrapError('Controller asset changed during read');
    return out.subarray(0,len);
  }finally{closeSync(fd);}
}
function writePrivate(path,data){
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|
    constants.O_NOFOLLOW,0o600);
  try{
    writeFileSync(fd,data);
    fsyncSync(fd);
  }finally{closeSync(fd);}
}
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
function sshKey(raw){
  if(raw.length!==51||raw.readUInt32BE(0)!==11||
     raw.subarray(4,15).toString()!=='ssh-ed25519'||
     raw.readUInt32BE(15)!==32)
    throw new ControllerBootstrapError('SSH host key is not a canonical Ed25519 blob');
}
function publicSshKeyFromLine(line){
  const parts=line.trim().split(/\s+/);
  if(parts.length<2||parts[0]!=='ssh-ed25519'||
     !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1]))
    throw new ControllerBootstrapError('Expected an Ed25519 SSH public key');
  const raw=Buffer.from(parts[1],'base64');
  if(raw.toString('base64')!==parts[1])throw new ControllerBootstrapError('Noncanonical SSH public key');
  sshKey(raw);
  return raw;
}
function sshFingerprint(raw){
  return 'SHA256:'+createHash('sha256').update(raw).digest('base64').replace(/=+$/,'');
}
function verifyHostPin(root,approved){
  const path=join(root,'fi-known_hosts');
  if(!existsSync(path)&&!lstatSync(path,{throwIfNoEntry:false}))
    return false;
  const content=privateRead(path,4096).toString('utf8');
  const lines=content.split('\n').map(x=>x.trim()).filter(x=>x&&!x.startsWith('#'));
  if(lines.length!==1)
    throw new ControllerBootstrapError('FI SSH known_hosts must have one independently approved key');
  const fields=lines[0].split(/\s+/);
  if(fields.length<3||fields[0]!=='fi.mnebyvpn.site')
    throw new ControllerBootstrapError('FI SSH HostKeyAlias must match independently approved hostname');
  const raw=publicSshKeyFromLine(fields.slice(1).join(' '));
  if(!approved)return false;
  if(!SSH_FINGERPRINT.test(approved)||sshFingerprint(raw)!==approved)
    throw new ControllerBootstrapError('FI host key differs from independent SSH fingerprint');
  return true;
}
function verifyFiIdentity(root){
  const path=join(root,'fi-node-public.spki');
  if(!existsSync(path)&&!lstatSync(path,{throwIfNoEntry:false}))return false;
  const publicKey=privateRead(path,100);
  if(publicKey.length!==44||!publicKey.subarray(0,12).equals(PREFIX)||
     sha(publicKey)!==FI_SHA)
    throw new ControllerBootstrapError('FI node Ed25519 identity differs from approved inventory');
  return true;
}
function verifyController(root){
  const key=createPrivateKey(privateRead(join(root,FILES.signer),8192));
  if(key.type!=='private'||key.asymmetricKeyType!=='ed25519')
    throw new ControllerBootstrapError('Controller signing key is not Ed25519');
  const actual=createPublicKey(key).export({format:'der',type:'spki'});
  if(actual.length!==44||!actual.subarray(0,12).equals(PREFIX)||
     !actual.equals(privateRead(join(root,FILES.public),100)))
    throw new ControllerBootstrapError('Controller public SPKI does not match protected signer');
  const publicLine=privateRead(join(root,FILES.sshPublic),512).toString('utf8');
  const expected=publicSshKeyFromLine(publicLine);
  const sshVerify=spawnSync('/usr/bin/ssh-keygen',
    ['-y','-P','','-f',join(root,FILES.sshPrivate)],
    {encoding:'utf8',timeout:10_000,maxBuffer:2048});
  if(sshVerify.status!==0||
     !expected.equals(publicSshKeyFromLine(sshVerify.stdout??'')))
    throw new ControllerBootstrapError('Enrollment SSH private/public keys differ');
  // Check private SSH key ownership AFTER ssh-keygen. The private key never
  // leaves the trusted controller.
  privateRead(join(root,FILES.sshPrivate),8192);
  const manifest=JSON.parse(privateRead(join(root,FILES.manifest),4096).toString());
  if(manifest.schema_version!==1||manifest.state!=='awaiting_independent_approval'||
     manifest.controller_public_sha256!==sha(actual)||
     manifest.fi_node_id!=='fi-test-01'||manifest.client_publication!==false)
    throw new ControllerBootstrapError('Unapproved bootstrap manifest mismatch');
  return sha(actual);
}
/**
 * The real CLI must NOT create a second control-plane on FI, DE89, or a CI
 * runner. Existing 188 deployment + locally assigned 188 IPv4 are hard
 * prerequisites (not proof that every database/service is healthy).
 * Tests of the pure bootstrap functions use disposable roots and keys.
 */
export function requireExistingController188({
  addresses=Object.values(networkInterfaces()).flat().filter(Boolean)
    .filter(x=>x.family==='IPv4').map(x=>x.address),
  deploymentRoot=EXISTING_CONTROLLER_ROOT,
}={}){
  requireRoot();
  if(!Array.isArray(addresses)||!addresses.includes(CONTROLLER188))
    throw new ControllerBootstrapError('Only existing RU188 central controller is supported');
  const st=lstatSync(deploymentRoot,{throwIfNoEntry:false});
  if(!st||!st.isDirectory()||st.isSymbolicLink()||st.uid!==0)
    throw new ControllerBootstrapError('Existing MNEBYVPN controller deployment absent');
  return {controller_host:CONTROLLER188,existing_deployment_verified:true};
}

export function initializeController(root=DEFAULT_ROOT){
  requireRoot();
  safeRoot(root);
  const parent=dirname(root);
  const staging=mkdtempSync(join(parent,'.controller-bootstrap-stage-'));
  let promoted=false;
  try{
    chmodSync(staging,0o700);
    directory(staging,{privateDir:true});
    const pair=generateKeyPairSync('ed25519',{
      privateKeyEncoding:{format:'pem',type:'pkcs8'},
      publicKeyEncoding:{format:'der',type:'spki'},
    });
    if(pair.publicKey.length!==44||!pair.publicKey.subarray(0,12).equals(PREFIX))
      throw new ControllerBootstrapError('Invalid Ed25519 public signer identity');
    writePrivate(join(staging,FILES.signer),pair.privateKey);
    writePrivate(join(staging,FILES.public),pair.publicKey);
    const sshFile=join(staging,FILES.sshPrivate);
    const sshResult=spawnSync('/usr/bin/ssh-keygen',[
      '-q','-t','ed25519','-N','','-C','nodekit-fi-enrollment-only','-f',sshFile,
    ],{timeout:15000,encoding:'utf8',maxBuffer:4096});
    if(sshResult.status!==0)
      throw new ControllerBootstrapError('Local dedicated SSH key generation failed');
    chmodSync(sshFile,0o600);
    chmodSync(join(staging,FILES.sshPublic),0o600);
    const controllerSha=sha(pair.publicKey);
    writePrivate(join(staging,FILES.manifest),JSON.stringify({
      schema_version:1,state:'awaiting_independent_approval',
      controller_public_sha256:controllerSha,fi_node_id:'fi-test-01',
      client_publication:false,
    })+'\n');
    verifyController(staging);
    // Parent is root-owned and nonwritable by other users; promotion never
    // silently replaces an existing trust root.
    safeRoot(root);
    renameSync(staging,root);
    promoted=true;
    return {
      controller_public_sha256:controllerSha,
      state:'awaiting_independent_approval',node_id:'fi-test-01',
      public_spki_path:join(root,FILES.public),
      ssh_enrollment_public_path:join(root,FILES.sshPublic),
      private_key_exported:false,host_key_pinned:false,
      node_identity_approved:false,client_publication:false,
    };
  }finally{if(!promoted)rmSync(staging,{recursive:true,force:true});}
}
export function auditController(root=DEFAULT_ROOT,{
  approvedControllerSha256='',approvedFiSshFingerprint='',
}={}){
  requireRoot();
  safeRoot(root,{existing:true});
  const actual=verifyController(root);
  if(approvedControllerSha256&&(!SHA.test(approvedControllerSha256)||
     actual!==approvedControllerSha256))
    throw new ControllerBootstrapError('Controller key differs from independent Ed25519 pin');
  const signerApproved=Boolean(approvedControllerSha256);
  const hostApproved=verifyHostPin(root,approvedFiSshFingerprint);
  const fiNodeApproved=verifyFiIdentity(root);
  return {
    state:'staged',
    node_id:'fi-test-01',
    controller_key_consistent:true,
    controller_key_independently_pinned:signerApproved,
    fi_host_key_independently_pinned:hostApproved,
    fi_node_identity_matched:fiNodeApproved,
    local_ssh_enrollment_material_ready:signerApproved&&hostApproved&&fiNodeApproved,
    database_inventory_approved:false,
    enrollment_performed:false,
    subscriber_publication:false,
  };
}
function cli(args){
  if(!['init','audit'].includes(args[0]))throw new ControllerBootstrapError('Use init or audit');
  requireExistingController188();
  let root=DEFAULT_ROOT,shaPin='',hostPin='';
  const rest=args.slice(1);
  while(rest.length){
    const opt=rest.shift(),value=rest.shift();
    if(!value)throw new ControllerBootstrapError('Missing controller bootstrap option');
    if(opt==='--root')root=value;
    else if(opt==='--approved-controller-sha256')shaPin=value;
    else if(opt==='--approved-fi-host-sha256')hostPin=value;
    else throw new ControllerBootstrapError('Unexpected controller bootstrap option');
  }
  if(args[0]==='init'&&(shaPin||hostPin))
    throw new ControllerBootstrapError('Independent approvals are not generated during bootstrap');
  return args[0]==='init'?initializeController(root):
    auditController(root,{approvedControllerSha256:shaPin,
                          approvedFiSshFingerprint:hostPin});
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  try{process.stdout.write(JSON.stringify(cli(process.argv.slice(2)))+'\n');}
  catch{
    // No SSH private keys, raw signer PEM or environment values in logs.
    process.stderr.write('CONTROLLER_BOOTSTRAP_STOPPED\n');
    process.exitCode=2;
  }
}
