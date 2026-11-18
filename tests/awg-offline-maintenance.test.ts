import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import test from 'node:test';
import {stageDueOfflineAwgMaintenance} from '../packages/provisioning/src/awg-offline-maintenance.ts';

const NOW=new Date('2026-11-18T04:30:00.000Z');
const ENTITLEMENT='11111111-2222-4333-8444-555555555555';
const KEY=Buffer.from(Array.from({length:32},(_,i)=>i)).toString('base64');
const {privateKey}=generateKeyPairSync('ed25519');

function pretendController(mode:'empty'|'renew'|'revoke'|'denied'){
  const queries:string[]=[];
  let staged=0;
  const row={node_id:'fi-test-01',entitlement_id:ENTITLEMENT,
    allocation_revision:3,billing_revision:7,peer_public_key:KEY};
  const client={
    async query(sql:string,args:unknown[]=[]){
      queries.push(sql);
      if(sql.startsWith('SELECT id::text,product,state,revision'))
        return {rows:[{id:ENTITLEMENT,product:'vpn',state:'ACTIVE',
          revision:7,expires_at:new Date(NOW.getTime()+30*86400000)}]};
      if(sql.startsWith('SELECT endpoint_host,status'))
        return {rows:[{endpoint_host:'fi.mnebyvpn.site',status:'enrolled'}]};
      if(sql.startsWith('SELECT node_id,endpoint_host,state,subnet_cidr'))
        return {rows:[{node_id:'fi-test-01',endpoint_host:'fi.mnebyvpn.site',
          state:'verified',subnet_cidr:'10.73.91.0/24',
          verified_at:new Date(NOW.getTime()-1000),server_public_key:KEY}]};
      if(sql.startsWith('SELECT enabled FROM vpn_release_flags'))
        return {rows:[{enabled:mode!=='denied'}]};
      if(sql.startsWith('SELECT peer_public_key,host(client_ipv4)'))
        return {rows:[{peer_public_key:KEY,client_ipv4:'10.73.91.2',
          revision:3,state:'applied'}]};
      if(sql.startsWith('SELECT host(client_ipv4) AS client_ipv4 FROM '))
        return {rows:[{client_ipv4:'10.73.91.2'}]};
      if(sql.startsWith('INSERT INTO vpn_awg_command_outbox'))staged++;
      return {rows:[],rowCount:1};
    },
    release(){queries.push('RELEASE');},
  };
  const db={
    async query(sql:string,args:unknown[]=[]){
      queries.push(sql);
      if(sql.includes("e.state<>'ACTIVE'"))
        return {rows:mode==='revoke'?[row]:[]};
      if(sql.includes("e.state='ACTIVE'"))
        return {rows:mode==='renew'||mode==='denied'?[row]:[]};
      throw Error('Unexpected background selection');
    },
    async connect(){return client;},
  };
  return {db,queries,get staged(){return staged;}};
}

test('background no-op needs no SSH, credentials or user connection',async()=>{
  const controller=pretendController('empty');
  const result=await stageDueOfflineAwgMaintenance(controller.db as never,privateKey,NOW);
  assert.deepEqual(result,{stagedRenewals:0,stagedRevocations:0,failed:0});
  assert.equal(controller.staged,0);
  assert.equal(controller.queries.filter(s=>s.startsWith('SELECT')).length,2);
  assert(!controller.queries.some(s=>s.includes('socket')||s.includes('handshake')));
});

test('asynchronous renewal uses active billing and existing peer revision',async()=>{
  const controller=pretendController('renew');
  const result=await stageDueOfflineAwgMaintenance(controller.db as never,privateKey,NOW);
  assert.deepEqual(result,{stagedRenewals:1,stagedRevocations:0,failed:0});
  assert.equal(controller.staged,1);
  assert(controller.queries.some(s=>s.includes("state='staged'")));
});

test('asynchronous cancellation wins over renewal and creates revoke outbox',async()=>{
  const controller=pretendController('revoke');
  const result=await stageDueOfflineAwgMaintenance(controller.db as never,privateKey,NOW);
  assert.deepEqual(result,{stagedRenewals:0,stagedRevocations:1,failed:0});
  assert.equal(controller.staged,1);
  assert(controller.queries.some(s=>s.includes("state='revoked'")));
});

test('release-disabled refuses renewed local access but keeps worker alive',async()=>{
  const controller=pretendController('denied');
  const result=await stageDueOfflineAwgMaintenance(controller.db as never,privateKey,NOW);
  assert.deepEqual(result,{stagedRenewals:0,stagedRevocations:0,failed:1});
  assert.equal(controller.staged,0);
});

test('maintenance rejects untrusted signer and unbounded batch',async()=>{
  const controller=pretendController('empty');
  const wrong=generateKeyPairSync('ed25519').publicKey;
  await assert.rejects(stageDueOfflineAwgMaintenance(controller.db as never,wrong,NOW));
  await assert.rejects(stageDueOfflineAwgMaintenance(controller.db as never,privateKey,NOW,200));
  assert.equal(controller.queries.length,0);
});
