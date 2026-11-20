import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
  isCanonicalAwgPublicKey,loadVerifiedAwgMaterial,renderLocalAwgConfig,
  verifiedAwgMaterial,
} from '../packages/provisioning/src/awg-subscriber-material.ts';

const clock=Date.parse('2026-11-20T12:00:00.000Z');
const issued=new Date(clock-20_000);
const expires=new Date(clock+3600_000);
const owner={
  entitlementId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  revision:11,expiresAt:new Date(clock+2*3600_000),
};
function keyPair(){
  const {publicKey,privateKey}=generateKeyPairSync('x25519');
  const pub=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
  const priv=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64');
  return {pub,priv};
}
const client=keyPair();
const server=keyPair();
const header=keyPair().pub;
const sample=()=>({
  enabled:true,node_id:'fi-test-01',endpoint_host:'fi.mnebyvpn.site',
  listen_port:51821,subnet_cidr:'10.73.91.0/24',
  pool_state:'verified',enrollment_status:'enrolled',
  verified_at:new Date(clock-60_000),
  server_public_key:server.pub,
  peer_public_key:client.pub,
  client_ipv4:'10.73.91.2',
  allocation_state:'applied',allocation_revision:3,expires_at:expires,
  outbox_state:'applied',outbox_op:'grant',
  outbox_billing_revision:'11',
  outbox_command_sha256:'a'.repeat(64),
  last_command_sha256:'a'.repeat(64),
  node_receipt_sha256:'b'.repeat(64),
  command_peer_key:client.pub,command_client_ip:'10.73.91.2',
});

test('a real FI outbox signed ACK may produce native AWG 3.1 connection material',()=>{
  const material=verifiedAwgMaterial(sample(),owner,client.pub,header,clock);
  assert.ok(material);
  assert.equal(material.protocol,'AmneziaWG 3.1');
  assert.equal(material.countryName,'Финляндия');
  assert.equal(material.clientAddress,'10.73.91.2/32');
  assert.equal(material.endpoint,'fi.mnebyvpn.site:51821');
  assert.equal(material.expiresAt,expires.toISOString());
  assert.ok(!JSON.stringify(material).includes(client.priv));
  const file=renderLocalAwgConfig(material,client.priv);
  assert.match(file,/^\[Interface\]\nAddress = 10\.73\.91\.2\/32/m);
  assert.match(file,/^PrivateKey = [A-Za-z0-9+/]{43}=$/m);
  assert.match(file,/^HeaderProtectionKey = [A-Za-z0-9+/]{43}=$/m);
  assert.match(file,/^RandomTrailers = on$/m);
  assert.match(file,/^S4 = 16$/m);
  assert.match(file,/^Endpoint = fi\.mnebyvpn\.site:51821$/m);
  assert.match(file,/^AllowedIPs = 0\.0\.0\.0\/0$/m);
  assert.equal(file.split('[Peer]').length,2);
});

test('no profile without verified node, paid revision, local grant and ACK',()=>{
  const failed=[
    {enabled:false},{pool_state:'staged'},{pool_state:'degraded'},
    {enrollment_status:'revoked'},{verified_at:new Date(clock-3600_001)},
    {verified_at:new Date(clock+40_000)},
    {server_public_key:keyPair().pub},{peer_public_key:keyPair().pub},
    {client_ipv4:'10.73.91.1'},{client_ipv4:'10.73.91.255'},
    {allocation_state:'staged'},{allocation_state:'revoked'},
    {expires_at:new Date(clock-1)},{expires_at:new Date(clock+3*3600_000)},
    {outbox_state:'claimed'},{outbox_state:'queued'},{outbox_op:'revoke'},
    {outbox_billing_revision:10},{outbox_billing_revision:'11.0'},
    {outbox_command_sha256:'invalid'},
    {last_command_sha256:'b'.repeat(64)},
    {node_receipt_sha256:null},{command_peer_key:keyPair().pub},
    {command_client_ip:'10.73.91.6'},
    {endpoint_host:'evil.example.com'},{listen_port:51822},
    {subnet_cidr:'10.73.92.0/24'},
  ];
  for(const wrong of failed){
    assert.equal(verifiedAwgMaterial({...sample(),...wrong} as ReturnType<typeof sample>,
      owner,client.pub,header,clock),null,JSON.stringify(wrong));
  }
  assert.equal(verifiedAwgMaterial(sample(),{...owner,revision:12},
    client.pub,header,clock),null);
  assert.equal(verifiedAwgMaterial(sample(),{...owner,expiresAt:new Date(clock-1)},
    client.pub,header,clock),null);
});

test('reject noncanonical peer keys and invalid local private keys',()=>{
  for(const key of ['x','A'.repeat(44),'A'.repeat(43)+'=',' '.repeat(44),
                    client.pub.replace('+','-'),'\n'+client.pub]){
    if(key!==client.pub) assert.equal(isCanonicalAwgPublicKey(key),false);
  }
  assert.equal(isCanonicalAwgPublicKey(client.pub),true);
  assert.equal(verifiedAwgMaterial(sample(),owner,'bad',header,clock),null);
  assert.equal(verifiedAwgMaterial(sample(),owner,client.pub,'bad',clock),null);
  const material=verifiedAwgMaterial(sample(),owner,client.pub,header,clock)!;
  assert.throws(()=>renderLocalAwgConfig(material,'not-a-key'));
  assert.throws(()=>renderLocalAwgConfig({...material,endpoint:'bad.example.com:51821'} as unknown as typeof material,client.priv));
});

test('database reader is read-only, parameterized, checked against a canonical owner and peer',async()=>{
  let seen='';
  let args:unknown[]=[];
  const pool={
    query:async(sql:string,params:unknown[])=>{
      seen=sql;args=params;return {rows:[sample()]};
    },
  };
  const material=await loadVerifiedAwgMaterial(pool as never,owner,client.pub,header,clock);
  assert.ok(material);
  assert.deepEqual(args,[owner.entitlementId,client.pub,'vpn_awg_clients','fi-test-01']);
  assert.match(seen,/vpn_release_flags/);
  assert.match(seen,/vpn_awg_command_outbox/);
  assert.match(seen,/vpn_node_enrollment_inventory/);
  assert.match(seen,/vpn_awg_peer_allocations/);
  assert.match(seen,/a\.revision/);
  assert.ok(!/\b(?:INSERT|UPDATE|DELETE|GRANT|ALTER)\b/i.test(seen));
  const none=await loadVerifiedAwgMaterial({
    query:async()=>({rows:[]}),
  } as never,owner,client.pub,header,clock);
  assert.equal(none,null);
  const duplicates=await loadVerifiedAwgMaterial({
    query:async()=>({rows:[sample(),sample()]}),
  } as never,owner,client.pub,header,clock);
  assert.equal(duplicates,null);
});

test('website AWG material is separate from existing VLESS subscription and private-key free',()=>{
  const site=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  assert.match(site,/WEB_FI_AWG_MATERIAL_ENABLED==='yes'/);
  assert.ok(site.includes('const awgMatch='));
  assert.ok(site.includes('const subMatch='));
  assert.match(site,/Cache-Control','no-store/);
  assert.match(site,/AWG_PEER_NOT_ACKNOWLEDGED/);
  assert.match(site,/subscriptionOwner\(subscriptionPool,awgMatch\[1\]\)/);
  assert.ok(!site.includes("renderLocalAwgConfig("));
  const material=readFileSync(
    new URL('../packages/provisioning/src/awg-subscriber-material.ts',import.meta.url),'utf8');
  assert.ok(!material.includes('createPrivateKey('));
  assert.ok(!material.includes('sign(null'));
});
