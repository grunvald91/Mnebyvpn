import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,sign,verify}
  from 'node:crypto';
import {
  awgSlotLeasePayload,awgSlotReceiptPayload,signAwgSlotLease,
  verifyAwgSlotReceipt,type AwgSlotLeaseV2Draft,
  type AwgSlotReceiptV2,
} from '../packages/provisioning/src/awg-device-lease-v2.ts';
const now=new Date('2026-11-21T18:00:00.000Z');
const expires='2026-11-21T19:00:00.000Z';
const entitlement='11111111-2222-4333-8444-555555555555';
const controller=generateKeyPairSync('ed25519');
const node=generateKeyPairSync('ed25519');
const key=()=>randomBytes(32).toString('base64');
const publicKey=key();
const make=(overrides:Partial<AwgSlotLeaseV2Draft>={})=>({
  nodeId:'fi-test-01' as const,op:'grant' as const,
  entitlementId:entitlement,slotNumber:1 as const,revision:1,
  peerPublicKey:publicKey,clientIpv4:'10.73.91.3',
  expiresAt:expires,issuedAt:now.toISOString(),nonce:'a'.repeat(64),
  ...overrides,
});

test('V2 byte exact payload includes slot and does not equal legacy V1 domain',()=>{
  const cmd=signAwgSlotLease(make(),controller.privateKey,now);
  const payload=awgSlotLeasePayload(cmd);
  assert.deepEqual(JSON.parse(payload.toString('utf8')),[
    'MNEBYVPN_AWG_DEVICE_LEASE_V2','fi-test-01','grant',entitlement,
    1,1,publicKey,'10.73.91.3',expires,now.toISOString(),'a'.repeat(64),
  ]);
  assert.equal(verify(null,payload,controller.publicKey,
    Buffer.from(cmd.signature,'base64url')),true);
  assert.equal(cmd.signature.length,86);
  assert.equal(JSON.stringify(cmd).includes('privateKey'),false);
  assert.notEqual(JSON.parse(payload.toString('utf8'))[0],'MNEBYVPN_AWG_LEASE_V1');
});

test('three separately signed V2 slots have distinct authenticated identities',()=>{
  for(const n of [1,2,3] as const){
    const cmd=signAwgSlotLease(make({
      slotNumber:n,peerPublicKey:key(),clientIpv4:'10.73.91.'+(n+2),
      nonce:n.toString(16).repeat(64),
    }),controller.privateKey,now);
    assert.equal(cmd.slotNumber,n);
    assert.equal(verify(null,awgSlotLeasePayload(cmd),controller.publicKey,
      Buffer.from(cmd.signature,'base64url')),true);
  }
});

test('node V2 ACK is bound to node, slot, op, revision and command hash',()=>{
  const cmd=signAwgSlotLease(make(),controller.privateKey,now);
  const base={
    nodeId:cmd.nodeId,op:cmd.op,entitlementId:cmd.entitlementId,
    slotNumber:cmd.slotNumber,revision:cmd.revision,
    commandSha256:createHash('sha256').update(awgSlotLeasePayload(cmd)).digest('hex'),
    appliedAt:now.toISOString(),nonce:'b'.repeat(64),
  };
  const receipt:AwgSlotReceiptV2={...base,
    signature:sign(null,awgSlotReceiptPayload(base),node.privateKey)
      .toString('base64url'),
  };
  assert.equal(verifyAwgSlotReceipt(cmd,receipt,node.publicKey,now),true);
  assert.equal(verifyAwgSlotReceipt(cmd,{...receipt,slotNumber:2},node.publicKey,now),false);
  assert.equal(verifyAwgSlotReceipt(cmd,{...receipt,revision:2},node.publicKey,now),false);
  assert.equal(verifyAwgSlotReceipt(cmd,{...receipt,commandSha256:'0'.repeat(64)},node.publicKey,now),false);
  assert.equal(verifyAwgSlotReceipt(cmd,{...receipt,nonce:'c'.repeat(64)},node.publicKey,now),false);
  assert.equal(verifyAwgSlotReceipt(cmd,receipt,controller.publicKey,now),false);
  const wrongCmd={...cmd,slotNumber:2 as const};
  assert.equal(verifyAwgSlotReceipt(wrongCmd,receipt,node.publicKey,now),false);
});

test('reject invalid slots, IPs, time, keys and accidental secret fields',()=>{
  const invalid:Partial<AwgSlotLeaseV2Draft>[]=[
    {slotNumber:4 as 1},{slotNumber:0 as 1},
    {slotNumber:true as unknown as 1},
    {clientIpv4:'10.73.91.253'},{clientIpv4:'10.73.91.1'},
    {clientIpv4:'10.73.92.3'},{clientIpv4:'10.73.91.03'},
    {peerPublicKey:Buffer.alloc(32).toString('base64')},
    {expiresAt:'2026-11-21T17:00:00.000Z'},
    {issuedAt:'2026-11-21T16:00:00.000Z'},
    {nonce:'x'.repeat(64)},{entitlementId:'../../invalid'},
    {nodeId:'other-node' as 'fi-test-01'},
    {revision:0},{revision:1.5},
  ];
  for(const change of invalid){
    assert.throws(()=>signAwgSlotLease(make(change),controller.privateKey,now),
      {name:'Error'},JSON.stringify(change));
  }
  assert.throws(()=>signAwgSlotLease({
    ...make(),privateKey:'never send customer private keys',
  } as AwgSlotLeaseV2Draft,controller.privateKey,now));
  assert.throws(()=>signAwgSlotLease(make({op:'revoke',expiresAt:expires}),
    controller.privateKey,now));
  assert.throws(()=>signAwgSlotLease(make({op:'grant',expiresAt:null}),
    controller.privateKey,now));
  assert.throws(()=>signAwgSlotLease(make(),node.publicKey,now));
  const revocation=signAwgSlotLease(make({op:'revoke',expiresAt:null,revision:2}),
    controller.privateKey,now);
  assert.equal(revocation.op,'revoke');
  assert.equal(revocation.expiresAt,null);
});
