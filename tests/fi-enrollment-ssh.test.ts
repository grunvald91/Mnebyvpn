import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  parseFiEnrollmentProof,fiEnrollmentSshArgs,FI_NODE_IDENTITY_SHA256,
  enrollApprovedFiNode,pinnedFiNodePublicSpki,
} from '../packages/provisioning/src/fi-enrollment-ssh.ts';
import {enrollmentChallengeMessage,type NodeEnrollmentChallenge}
  from '../packages/provisioning/src/node-enrollment.ts';

const node=generateKeyPairSync('ed25519');
const publicSpki=node.publicKey.export({format:'der',type:'spki'})
  .toString('base64url');
const challenge:NodeEnrollmentChallenge={
  nodeId:'fi-test-01',endpointHost:'fi.mnebyvpn.site',publicSpki,
  challengeId:'11111111-2222-4333-8444-555555555555',
  nonce:'A'.repeat(43),expiresAt:new Date('2026-11-18T12:00:00.000Z'),
  controllerSignature:'b'.repeat(86),
};

function signedProof(ch:NodeEnrollmentChallenge=challenge){
  const raw={
    nodeId:ch.nodeId,endpointHost:ch.endpointHost,publicSpki:ch.publicSpki,
    challengeId:ch.challengeId,nonce:ch.nonce,
  };
  const signature=sign(null,enrollmentChallengeMessage(raw),node.privateKey)
    .toString('base64url');
  return {...raw,signature};
}
function canonicalProof(value:Record<string,unknown>){
  return JSON.stringify(value,Object.keys(value).sort())+'\n';
}

test('valid FI signed node proof exactly matches one controller challenge',()=>{
  const proof=parseFiEnrollmentProof(canonicalProof(signedProof()),challenge);
  assert.equal(proof.nodeId,'fi-test-01');
  assert.equal(proof.challengeId,challenge.challengeId);
  assert.equal(proof.signature.length,86);
});

test('proof is rejected for wrong country, nonce, signature or unexpected JSON',()=>{
  const valid=signedProof();
  const bad=[
    {...valid,nodeId:'de-test-01'},
    {...valid,nonce:'B'.repeat(43)},
    {...valid,signature:'a'.repeat(86)},
    {...valid,challengeId:'11111111-2222-4333-8444-555555555556'},
    {...valid,extra:'true'},
    {...valid,publicSpki:'A'.repeat(59)},
  ];
  for(const item of bad)
    assert.throws(()=>parseFiEnrollmentProof(canonicalProof(item),challenge));
  const duplicate=canonicalProof(valid).replace(
    '"signature":','"signature":"'+ 'a'.repeat(86)+'","signature":',
  );
  for(const text of [
    '{}\n','not json\n','\n',JSON.stringify(valid),
    JSON.stringify(valid)+'\n',
    JSON.stringify(valid)+'\n{}\n','x'.repeat(2100)+'\n',duplicate,
  ])
    assert.throws(()=>parseFiEnrollmentProof(text,challenge));
});

test('FI enrollment SSH uses a forced-command identity, no password or TOFU',()=>{
  const args=fiEnrollmentSshArgs({
    sshIdentityFile:'/root/.ssh/mnebyvpn-fi-enroll',
    pinnedKnownHostsFile:'/root/mnebyvpn/known_hosts',
    approvedNodePublicSpkiFile:'/root/mnebyvpn/fi-node-public.spki',
  });
  const joined=args.join(' ');
  assert(joined.includes('StrictHostKeyChecking=yes'));
  assert(joined.includes('BatchMode=yes'));
  assert(joined.includes('PasswordAuthentication=no'));
  assert(joined.includes('HostKeyAlias=fi.mnebyvpn.site'));
  assert(joined.includes('HostName=217.11.167.91'));
  assert(joined.includes('ProxyCommand=none'));
  assert(joined.endsWith('root@fi.mnebyvpn.site false'));
  assert(!joined.includes('accept-new'));
  assert.equal(FI_NODE_IDENTITY_SHA256.length,64);
});

test('FI node public key pin refuses untrusted ancestry and path traversal',()=>{
  const dir=mkdtempSync(join(tmpdir(),'fi-enrollment-untrusted-'));
  try{
    const file=join(dir,'node.spki');
    writeFileSync(file,node.publicKey.export({format:'der',type:'spki'}));
    assert.throws(()=>pinnedFiNodePublicSpki(file),
      /Unsafe controller trust directory|Untrusted controller identity/);
    assert.throws(()=>pinnedFiNodePublicSpki('/tmp/../etc/hosts'),
      /Canonical absolute protected controller file/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('non-root enrollment cannot create any database challenge',async()=>{
  if(typeof process.getuid!=='function'||process.getuid()===0)return;
  let databaseTouched=false,sshStarted=false;
  const database={
    async connect(){
      databaseTouched=true;
      throw Error('Unexpected enrollment database use');
    },
  };
  await assert.rejects(enrollApprovedFiNode(
    database as never,generateKeyPairSync('ed25519').privateKey,{
      sshIdentityFile:'/tmp/untrusted-enroll-key',
      pinnedKnownHostsFile:'/tmp/untrusted-known-hosts',
      approvedNodePublicSpkiFile:'/tmp/untrusted-node-spki',
    },()=>{sshStarted=true;throw Error('Unexpected SSH start');},
  ),/Enrollment must execute as root/);
  assert.equal(databaseTouched,false);
  assert.equal(sshStarted,false);
});
