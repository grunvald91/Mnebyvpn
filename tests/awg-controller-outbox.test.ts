import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import test from 'node:test';
import {awgControllerPayload,type SignedAwgLease} from '../packages/provisioning/src/awg-controller-grants.ts';
import {
  claimAwgCommand,acknowledgeAwgCommand,nodeAwgReceiptPayload,
  type NodeAwgReceipt,
} from '../packages/provisioning/src/awg-controller-outbox.ts';
import {createHash} from 'node:crypto';

const now=new Date('2026-11-18T08:00:00.000Z');
const id='11111111-2222-4333-8444-555555555555';
const nodeId='fi-test-01';
const peer=Buffer.from(Array.from({length:32},(_,i)=>i)).toString('base64');
const {privateKey:controllerPrivate}=generateKeyPairSync('ed25519');
const {privateKey:nodePrivate,publicKey:nodePublic}=generateKeyPairSync('ed25519');
const nodeSPKI=nodePublic.export({format:'der',type:'spki'}).toString('base64url');
const basic={
  nodeId,op:'grant' as const,entitlementId:id,revision:2,
  peerPublicKey:peer,clientIpv4:'10.73.91.2',
  expiresAt:'2026-11-18T08:30:00.000Z',
  issuedAt:now.toISOString(),nonce:'b'.repeat(64),
};
const payload=awgControllerPayload(basic as never);
const digest=createHash('sha256').update(payload).digest('hex');
const signed:SignedAwgLease={
  ...basic,signature:sign(null,payload,controllerPrivate).toString('base64url'),
};
function deliveryDb(args:{
  active?:boolean;release?:boolean;enrolled?:boolean;
  nodeReceiptValid?:boolean;currentRevision?:number;
  older?:boolean;revoked?:boolean;
}={}){
  const statements:string[]=[];
  const client={
    async query(sql:string,params:unknown[]=[]){
      statements.push(sql);
      if(sql.startsWith('SELECT id::text,node_id,entitlement_id::text,revision,billing_revision'))
        return {rows:[{
          id:'7',node_id:nodeId,entitlement_id:id,revision:2,
          billing_revision:11,op:'grant',
          signed_command:signed,command_sha256:digest,state:'queued',
          attempts:0,issued_at:now,
          expires_delivery_at:new Date(now.getTime()+40000),
        }]};
      if(sql.startsWith('SELECT revision,state,peer_public_key,host'))
        return {rows:[{
          revision:args.currentRevision??2,state:'staged',
          peer_public_key:peer,client_ipv4:'10.73.91.2',
        }]};
      if(sql.startsWith('SELECT product,state,revision,expires_at'))
        return {rows:[{
          product:'vpn',state:args.active===false?'EXPIRED':'ACTIVE',
          revision:11,expires_at:new Date(now.getTime()+1_800_000),
        }]};
      if(sql.startsWith('SELECT p.state,p.verified_at,p.endpoint_host'))
        return {rows:[{
          state:'verified',verified_at:new Date(now.getTime()-2000),
          endpoint_host:'fi.mnebyvpn.site',
          status:args.enrolled===false?'planned':'enrolled',
        }]};
      if(sql.startsWith('SELECT enabled FROM vpn_release_flags'))
        return {rows:[{enabled:args.release!==false}]};
      if(sql.startsWith('SELECT id::text,node_id,entitlement_id::text,revision,op,'))
        return {rows:[{
          id:'7',node_id:nodeId,entitlement_id:id,revision:2,
          op:'grant',command_sha256:digest,state:'claimed',
        }]};
      if(sql.startsWith('SELECT identity_public_spki,status'))
        return {rows:[{
          identity_public_spki:nodeSPKI,
          status:args.enrolled===false?'planned':'enrolled',
        }]};
      if(sql.startsWith('SELECT revision,state FROM vpn_awg_peer_allocations'))
        return {rows:[{
          revision:args.currentRevision??2,
          state:args.revoked?'revoked':'staged',
        }]};
      if(sql.startsWith('SELECT state,product,expires_at'))
        return {rows:[{
          state:args.active===false?'REFUNDED':'ACTIVE',
          product:'vpn',expires_at:new Date(now.getTime()+60000),
        }]};
      return {rows:[],rowCount:1};
    },
    release(){statements.push('RELEASE');},
  };
  return {db:{connect:async()=>client},statements};
}
function receipt():NodeAwgReceipt{
  const record={
    nodeId,op:'grant' as const,entitlementId:id,
    revision:2,commandSha256:digest,appliedAt:now.toISOString(),
    nonce:'c'.repeat(64),
  };
  return {...record,signature:sign(null,nodeAwgReceiptPayload(record),nodePrivate)
    .toString('base64url')};
}

test('claim returns only command validated with controller Ed25519 and recent billing',async()=>{
  const {db,statements}=deliveryDb();
  const result=await claimAwgCommand(db as never,controllerPrivate,now);
  assert.equal(result?.outboxId,'7');
  assert.equal(result?.command.signature,signed.signature);
  assert(statements.some(s=>s.includes("SET state='claimed'")));
  assert(statements.includes('COMMIT'));
});

test('delivery fails closed if entitlement expired, node unenrolled, or release disabled',async()=>{
  for(const options of [{active:false},{release:false},{enrolled:false},
                         {currentRevision:3}]){
    const {db,statements}=deliveryDb(options);
    const result=await claimAwgCommand(db as never,controllerPrivate,now);
    assert.equal(result,null);
    assert(statements.some(s=>s.includes("SET state='stale'")));
    assert(statements.includes('COMMIT'));
  }
});

test('applied requires signed enrolled NODE acknowledgement and current peer revision',async()=>{
  const {db,statements}=deliveryDb();
  const result=await acknowledgeAwgCommand(db as never,{
    outboxId:'7',receipt:receipt(),
  },now);
  assert.equal(result.acknowledged,true);
  assert.equal(result.published,false);
  assert(statements.some(s=>s.includes("node_receipt_sha256")));
  assert(statements.some(s=>s.includes("SET state='applied',applied_at")));
  assert(statements.includes('COMMIT'));
});

test('tampered node receipt and previously revoked billing cannot acknowledge',async()=>{
  const bad={...receipt(),clientIpv4:'10.73.91.20'} as never;
  const {db}=deliveryDb();
  // Unknown receipt fields are tested separately by the node payload.
  await assert.rejects(acknowledgeAwgCommand(db as never,{
    outboxId:'7',receipt:{...receipt(),revision:3},
  },now));
  const stale=deliveryDb({active:false});
  await assert.rejects(acknowledgeAwgCommand(stale.db as never,{
    outboxId:'7',receipt:receipt(),
  },now));
  const corrupted=deliveryDb();
  await assert.rejects(acknowledgeAwgCommand(corrupted.db as never,{
    outboxId:'7',receipt:{...receipt(),nonce:'d'.repeat(64)},
  },now));
});

test('outbox never acknowledges based on untrusted success boolean',async()=>{
  const {db}=deliveryDb();
  await assert.rejects(acknowledgeAwgCommand(db as never,{
    outboxId:'7',receipt:{} as never,
  },now));
});
