import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {stageNextFiAwgDevice} from '../packages/provisioning/src/awg-device-registration-worker.ts';

const signer=generateKeyPairSync('ed25519').privateKey;
const entitlement=randomUUID();
const peer=randomBytes(32).toString('base64');
const pending=()=>({
  entitlement_id:entitlement,node_id:'fi-test-01',
  peer_public_key:peer,billing_revision:'11',attempts:0,
});

function stub(row:ReturnType<typeof pending>|null,allocation:
  {peer_public_key:string;state:string}|null){
  const calls:string[]=[];
  let updated:{state:string;claimed_at:Date|null}|null=null;
  const query=async(sql:string,args:unknown[]=[])=>{
    calls.push(sql);
    if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')
      return {rows:[],rowCount:0};
    if(sql.startsWith('SELECT entitlement_id::text'))
      return {rows:row?[row]:[],rowCount:row?1:0};
    if(sql.startsWith('UPDATE vpn_awg_device_requests SET state=')){
      updated={state:args[3] as string,claimed_at:null};
      return {rows:[],rowCount:1};
    }
    if(sql.startsWith("UPDATE vpn_awg_device_requests SET state='processing'"))
      return {rows:[],rowCount:1};
    if(sql.startsWith('SELECT peer_public_key,state FROM vpn_awg_peer_allocations'))
      return {rows:allocation?[allocation]:[],rowCount:allocation?1:0};
    throw Error('Unexpected fake SQL: '+sql.slice(0,80));
  };
  return {db:{query,connect:async()=>({query,release(){}})},
          calls,read:()=>updated};
}

test('idle queue never signs or creates a peer',async()=>{
  const fake=stub(null,null);
  assert.deepEqual(await stageNextFiAwgDevice(fake.db as never,signer),
    {status:'idle'});
  assert(!fake.calls.some(s=>s.includes('vpn_awg_peer_allocations')));
});

test('already staged signed grant is NOT issued twice after crash recovery',async()=>{
  const fake=stub(pending(),{peer_public_key:peer,state:'staged'});
  assert.deepEqual(await stageNextFiAwgDevice(fake.db as never,signer),
    {status:'already_staged'});
  assert.equal(fake.read()?.state,'staged');
  assert(fake.calls.some(s=>s.includes('FOR UPDATE SKIP LOCKED')));
  assert(!fake.calls.some(s=>s.includes('INSERT INTO vpn_awg_command_outbox')));
});

test('foreign existing peer binding fails closed, never rotates device',async()=>{
  const fake=stub(pending(),{peer_public_key:randomBytes(32).toString('base64'),state:'applied'});
  assert.deepEqual(await stageNextFiAwgDevice(fake.db as never,signer),
    {status:'blocked'});
  assert.equal(fake.read()?.state,'blocked');
  assert(!fake.calls.some(s=>s.includes('INSERT INTO vpn_awg_command_outbox')));
});

test('invalid root trust key cannot even claim queue',async()=>{
  const fake=stub(pending(),null);
  await assert.rejects(stageNextFiAwgDevice(fake.db as never,
    generateKeyPairSync('x25519').privateKey),/Trusted RU188 signer/);
  assert.equal(fake.calls.length,0);
});

test('public registration request never includes a private key',async()=>{
  const source=(await import('node:fs/promises')).readFile;
  const server=await source(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  const worker=await source(new URL('../apps/service/src/awg-controller-delivery-worker.ts',import.meta.url),'utf8');
  assert(server.includes("website_request_fi_awg_device("));
  assert(server.includes("csrfAllowed(req,auth.raw)"));
  assert(server.includes("WEB_FI_AWG_REGISTRATION_ENABLED"));
  assert(server.includes("sessionHash(auth.raw),entitlementId,peerPublicKey"));
  assert(worker.includes("stageNextFiAwgDevice("));
  assert(!worker.includes("WEB_FI_AWG_REGISTRATION_PRIVATE_KEY"));
});
