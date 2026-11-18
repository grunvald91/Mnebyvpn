import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import test from 'node:test';
import {
  stageAwgGrant,stageAwgRevoke,awgControllerPayload,
} from '../packages/provisioning/src/awg-controller-grants.ts';

const NOW=new Date('2026-11-18T04:30:00.000Z');
const ENTITLEMENT='11111111-2222-4333-8444-555555555555';
const KEY=Buffer.from(Array.from({length:32},(_,i)=>i)).toString('base64');
const {privateKey,publicKey}=generateKeyPairSync('ed25519');

function fakeDb(options:{
  entitled?:boolean;enrolled?:boolean;verified?:boolean;
  released?:boolean;existing?:boolean;expired?:boolean;
}={}){
  const queries:string[]=[];
  const client={
    async query(sql:string,args:unknown[]=[]){
      queries.push(sql);
      if(sql.startsWith('SELECT id::text,product,state,revision'))
        return {rows:[{id:ENTITLEMENT,product:'vpn',
          state:options.entitled===false?'EXPIRED':'ACTIVE',revision:7,
          expires_at:new Date(NOW.getTime()+(options.expired? -1000:86400000))}]};
      if(sql.startsWith('SELECT endpoint_host,status'))
        return {rows:[{endpoint_host:'fi.mnebyvpn.site',
          status:options.enrolled===false?'approved':'enrolled'}]};
      if(sql.startsWith('SELECT node_id,endpoint_host,state,subnet_cidr'))
        return {rows:[{
          node_id:'fi-test-01',endpoint_host:'fi.mnebyvpn.site',
          state:options.verified===false?'staged':'verified',
          subnet_cidr:'10.73.91.0/24',
          verified_at:new Date(NOW.getTime()-30000),
          server_public_key:KEY,
        }]};
      if(sql.startsWith('SELECT enabled FROM vpn_release_flags'))
        return {rows:[{enabled:options.released!==false}]};
      if(sql.startsWith('SELECT peer_public_key,host(client_ipv4)'))
        return {rows:options.existing?[{
          peer_public_key:KEY,client_ipv4:'10.73.91.2',revision:3,
        }]:[]};
      if(sql.startsWith('SELECT host(client_ipv4) AS client_ipv4 FROM '))
        return {rows:[{client_ipv4:'10.73.91.3'}]};
      return {rows:[],rowCount:1};
    },
    release(){queries.push('RELEASE');},
  };
  return {db:{connect:async()=>client},queries};
}

test('live billing + enrolled and verified node produces signed nonpublished grant',async()=>{
  const {db,queries}=fakeDb();
  const result=await stageAwgGrant(db as never,{
    nodeId:'fi-test-01',entitlementId:ENTITLEMENT,
    peerPublicKey:KEY,expectedBillingRevision:7,
  },privateKey,NOW);
  assert.equal(result.staged,true);
  assert.equal(result.published,false);
  assert.equal(result.command.op,'grant');
  assert.equal(result.command.clientIpv4,'10.73.91.2');
  assert.equal(result.command.expiresAt,'2026-11-18T05:30:00.000Z');
  assert(verify(null,awgControllerPayload(result.command),publicKey,
    Buffer.from(result.command.signature,'base64url')));
  assert(queries.some(q=>q.includes("state,last_signed_at,last_command_sha256")));
  assert(queries.some(q=>q.includes("INSERT INTO vpn_awg_command_outbox")));
  assert(!queries.some(q=>q.includes("SET state='enabled'")));
  assert(queries.includes('COMMIT'));
});

test('reissue after previous grant increases node revision without rotating client key',async()=>{
  const {db,queries}=fakeDb({existing:true});
  const result=await stageAwgGrant(db as never,{
    nodeId:'fi-test-01',entitlementId:ENTITLEMENT,
    peerPublicKey:KEY,expectedBillingRevision:7,
  },privateKey,NOW);
  assert.equal(result.command.revision,4);
  assert.equal(result.command.clientIpv4,'10.73.91.2');
  assert(queries.some(s=>s.startsWith('UPDATE vpn_awg_peer_allocations')));
});

test('cancelled billing, unapproved node or disabled release prevent grant',async()=>{
  for(const options of [
    {entitled:false},{expired:true},{enrolled:false},
    {verified:false},{released:false},
  ]){
    const {db,queries}=fakeDb(options);
    await assert.rejects(stageAwgGrant(db as never,{
      nodeId:'fi-test-01',entitlementId:ENTITLEMENT,
      peerPublicKey:KEY,expectedBillingRevision:7,
    },privateKey,NOW));
    assert(queries.includes('ROLLBACK'));
    assert(!queries.includes('COMMIT'));
  }
});

test('wrong billing revision and invalid client public key are rejected',async()=>{
  const {db}=fakeDb();
  await assert.rejects(stageAwgGrant(db as never,{
    nodeId:'fi-test-01',entitlementId:ENTITLEMENT,
    peerPublicKey:KEY,expectedBillingRevision:6,
  },privateKey,NOW));
  await assert.rejects(stageAwgGrant(db as never,{
    nodeId:'fi-test-01',entitlementId:ENTITLEMENT,
    peerPublicKey:'not-a-key',expectedBillingRevision:7,
  },privateKey,NOW));
});

test('revocation works for expired entitlement and is always a signed tombstone',async()=>{
  const {db,queries}=fakeDb({existing:true,entitled:false});
  const result=await stageAwgRevoke(db as never,{
    nodeId:'fi-test-01',entitlementId:ENTITLEMENT,
  },privateKey,NOW);
  assert.equal(result.command.op,'revoke');
  assert.equal(result.command.expiresAt,null);
  assert.equal(result.command.revision,4);
  assert(verify(null,awgControllerPayload(result.command),publicKey,
    Buffer.from(result.command.signature,'base64url')));
  assert(queries.some(q=>q.includes("state='revoked'")));
  assert(queries.some(q=>q.includes("INSERT INTO vpn_awg_command_outbox")));
  assert(queries.includes('COMMIT'));
});

test('revocation without allocation cannot mutate state',async()=>{
  const {db,queries}=fakeDb();
  await assert.rejects(stageAwgRevoke(db as never,{
    nodeId:'fi-test-01',entitlementId:ENTITLEMENT,
  },privateKey,NOW));
  assert(queries.includes('ROLLBACK'));
  assert(!queries.includes('COMMIT'));
});
