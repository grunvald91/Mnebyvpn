import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {
  awgSshArgs,awgRemoteApplyScript,parseAwgNodeReceipt,deliverNextAwgCommand,
} from '../packages/provisioning/src/awg-trusted-ssh-delivery.ts';
import type {SignedAwgLease} from '../packages/provisioning/src/awg-controller-grants.ts';

const id='11111111-2222-4333-8444-555555555555';
const {privateKey}=generateKeyPairSync('ed25519');
const dummy:SignedAwgLease={
  nodeId:'fi-test-01',op:'grant',entitlementId:id,revision:3,
  peerPublicKey:'A'.repeat(43)+'=',clientIpv4:'10.73.91.2',
  expiresAt:'2026-11-18T12:00:00.000Z',
  issuedAt:'2026-11-18T11:00:00.000Z',
  nonce:'a'.repeat(64),signature:'b'.repeat(86),
};

function fakeReceipt(overrides:Record<string,unknown>={}){
  const receipt={
    nodeId:'fi-test-01',op:'grant',entitlementId:id,revision:3,
    commandSha256:'1'.repeat(64),
    appliedAt:'2026-11-18T11:00:01.000Z',
    nonce:'2'.repeat(64),signature:'x'.repeat(86),...overrides,
  };
  return JSON.stringify({
    signed_command_verified:true,active:true,
    node_receipt:receipt,
  });
}

test('accept only explicitly bound node identity and actual signed receipt shape',()=>{
  const parsed=parseAwgNodeReceipt(fakeReceipt(),dummy);
  assert.equal(parsed.nodeId,'fi-test-01');
  assert.equal(parsed.revision,3);
  for(const bad of [
    fakeReceipt({revision:4}),
    fakeReceipt({nodeId:'de-test-01'}),
    fakeReceipt({signature:'bad'}),
    fakeReceipt({extra:true}),
    JSON.stringify({active:false,signed_command_verified:true,
                    node_receipt:JSON.parse(fakeReceipt()).node_receipt}),
    JSON.stringify({active:true,signed_command_verified:false,
                    node_receipt:JSON.parse(fakeReceipt()).node_receipt}),
    '{}', 'garbage', fakeReceipt()+'\n'+fakeReceipt(),
  ]){
    assert.throws(()=>parseAwgNodeReceipt(bad,dummy));
  }
});

test('never accept untrusted or missing SSH identity files',()=>{
  for(const config of [
    {sshIdentityFile:'relative',pinnedKnownHostsFile:'/tmp/nope'},
    {sshIdentityFile:'/tmp/no-such-ssh-key',pinnedKnownHostsFile:'/tmp/nope'},
    {sshIdentityFile:'/dev/null',pinnedKnownHostsFile:'/dev/null'},
  ]){
    assert.throws(()=>awgSshArgs(config));
  }
});

test('SSH apply flags are arguments to Python, never separate shell commands',()=>{
  // A semicolon before --node-id would turn the flags into a shell command.
  assert(awgRemoteApplyScript.includes(
    '/usr/bin/python3 /opt/mnebyvpn-nodekit/awg_peer_grants.py '+
    '--node-id fi-test-01 --mode apply --command "$tmp"'));
  assert(!awgRemoteApplyScript.includes('; --node-id'));
  assert(awgRemoteApplyScript.includes('cat > "$tmp"; /usr/bin/python3'));
});

test('untrusted transport cannot claim a DB command',async()=>{
  let dbTouched=false;
  const fakeDb={connect:async()=>{
    dbTouched=true;
    throw new Error('should not query before SSH host pin verification');
  }};
  await assert.rejects(
    deliverNextAwgCommand(fakeDb as never,privateKey,{
      sshIdentityFile:'/tmp/non-existent-nodekit-ssh-key',
      pinnedKnownHostsFile:'/tmp/non-existent-nodekit-hosts',
    }),
  );
  assert.equal(dbTouched,false);
});
