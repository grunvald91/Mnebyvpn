import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import test from 'node:test';
import {stageSignedNodeReceipt,quarantineAdditionalNode}
  from '../packages/provisioning/src/nodekit-controller-catalog.ts';
import {additionalNodeReceiptPayload,type AdditionalNodeReceipt}
  from '../packages/provisioning/src/multi-node-subscriptions.ts';

const NOW=new Date('2026-11-17T20:00:00.000Z');
const ID='11111111-2222-4333-8444-555555555555';
const PROFILE='vless://'+ID+'@fi-test.mnebyvpn.site:2053?'+
  'encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision&'+
  'sni=www.cloudflare.com&fp=chrome&pbk='+'A'.repeat(43)+'&sid=0011223344556677&spx=%2F';

const {publicKey,privateKey}=generateKeyPairSync('ed25519');
function signedReceipt():AdditionalNodeReceipt {
  const base={
    node_id:'fi-test-01',country_code:'FI',country_name_ru:'Финляндия',
    endpoint_host:'fi-test.mnebyvpn.site',endpoint_port:2053,state:'enabled',
    exit_country_proof_sha256:'a'.repeat(64),
    vpn_e2e_proof_sha256:'b'.repeat(64),
    verified_at:new Date(NOW.getTime()-40_000),
    entitlement_id:ID,revision:3,
    expires_at:new Date(NOW.getTime()+3_600_000),
    observed_at:new Date(NOW.getTime()-20_000),profile_uri:PROFILE,
  };
  return {...base,signature:sign(null,additionalNodeReceiptPayload(
    {...base,signature:''} as AdditionalNodeReceipt
  ),privateKey).toString('base64url')};
}
function mockDb(options:{active?:boolean;existing?:string;enrolled?:boolean}={}) {
  const queries:string[]=[];
  const client={
    async query(sql:string){
      queries.push(sql);
      if(sql.startsWith('SELECT id::text'))
        return {rows:[{
          id:ID,product:'vpn',state:options.active===false?'EXPIRED':'ACTIVE',
          revision:3,expires_at:new Date(NOW.getTime()+3_600_000)
        }],rowCount:1};
      if(sql.startsWith('SELECT endpoint_host,status'))
        return {rows:[{
          endpoint_host:'fi-test.mnebyvpn.site',
          status:options.enrolled===false?'planned':'enrolled',
          identity_public_spki:'A'.repeat(59)
        }],rowCount:1};
      if(sql.startsWith('SELECT state,endpoint_host'))
        return {rows:options.existing?[{
          state:options.existing,endpoint_host:'fi-test.mnebyvpn.site'
        }]:[],rowCount:options.existing?1:0};
      return {rows:[],rowCount:1};
    },
    release(){queries.push('RELEASE');}
  };
  return {queries,pool:{connect:async()=>client}};
}

test('valid signed receipt is staged as verified, never enabled',async()=>{
  const {pool,queries}=mockDb();
  const result=await stageSignedNodeReceipt(
    pool as never,signedReceipt(),publicKey,NOW
  );
  assert.deepEqual(result,{nodeId:'fi-test-01',staged:true,published:false});
  assert(queries.some(x=>x.includes("VALUES ($1,$2,$3,$4,$5,'verified'")));
  assert(!queries.some(x=>x.includes("SET state='enabled'")));
  assert(queries.includes('COMMIT'));
});

test('tampered signature never causes a catalog write',async()=>{
  const {pool,queries}=mockDb();
  const row=signedReceipt();
  row.signature='A'.repeat(86);
  await assert.rejects(stageSignedNodeReceipt(pool as never,row,publicKey,NOW));
  assert(queries.includes('ROLLBACK'));
  assert(!queries.some(x=>x.startsWith('INSERT INTO vpn_additional_nodes')));
});

test('inactive billing entitlement refuses grants',async()=>{
  const {pool,queries}=mockDb({active:false});
  await assert.rejects(stageSignedNodeReceipt(
    pool as never,signedReceipt(),publicKey,NOW
  ));
  assert(queries.includes('ROLLBACK'));
  assert(!queries.includes('COMMIT'));
});

test('already enabled node cannot be silently replaced',async()=>{
  const {pool,queries}=mockDb({existing:'enabled'});
  await assert.rejects(stageSignedNodeReceipt(
    pool as never,signedReceipt(),publicKey,NOW
  ));
  assert(queries.includes('ROLLBACK'));
});

test('quarantine targets only named node and never touches entitlements',async()=>{
  const {pool,queries}=mockDb();
  const result=await quarantineAdditionalNode(pool as never,'fi-test-01',NOW);
  assert.equal(result.quarantined,true);
  assert(queries.some(q=>q.includes("SET state='degraded'")));
  assert(!queries.some(q=>q.includes('UPDATE entitlements')));
  await assert.rejects(quarantineAdditionalNode(pool as never,'../../pwn',NOW));
});
