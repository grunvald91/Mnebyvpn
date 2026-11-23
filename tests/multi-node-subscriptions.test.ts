import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {
  additionalNodeReceiptPayload,additionalNodeVerificationKey,
  verifiedAdditionalVpnLinks,type AdditionalNodeReceipt,
} from '../packages/provisioning/src/multi-node-subscriptions.ts';

const user='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const credential='12222222-3333-4333-8333-555555555555';
const now=new Date('2026-11-17T01:00:00Z');
const expiresAt=new Date(now.getTime()+24*3600_000);
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const pub=additionalNodeVerificationKey(
  publicKey.export({format:'der',type:'spki'}).toString('base64url'));
const owner={entitlementId:user,revision:3,expiresAt};

function receipt(nodeId='nl-node-02',country='NL',countryRu='Нидерланды'):
  AdditionalNodeReceipt {
  const host=nodeId+'.nodes.example.net';
  const profileUri='vless://'+credential+'@'+host+':2053?encryption=none'+
    '&security=reality&type=tcp&flow=xtls-rprx-vision'+
    '&sni=www.cloudflare.com&fp=chrome&pbk='+('A'.repeat(43))+
    '&sid=ab12cd34ef56a789&spx=%2F';
  const row:AdditionalNodeReceipt={
    node_id:nodeId,country_code:country,country_name_ru:countryRu,
    endpoint_host:host,endpoint_port:2053,state:'enabled',
    exit_country_proof_sha256:'a'.repeat(64),
    vpn_e2e_proof_sha256:'b'.repeat(64),
    verified_at:now,entitlement_id:user,revision:3,expires_at:expiresAt,
    observed_at:now,profile_uri:profileUri,signature:'',
  };
  row.signature=sign(null,additionalNodeReceiptPayload(row),privateKey).toString('base64url');
  return row;
}
function signed(overrides:Partial<AdditionalNodeReceipt>={},source=receipt()){
  const row={...source,...overrides};
  row.signature=sign(null,additionalNodeReceiptPayload(row),privateKey).toString('base64url');
  return row;
}

test('valid Ed25519 node shows country-only name, without exposing signature',()=>{
  const de=receipt('de-node-01','DE','Германия');
  const nl=receipt();
  const links=verifiedAdditionalVpnLinks([de,nl],owner,pub,now.getTime());
  assert.equal(links.length,2);
  assert.equal(decodeURIComponent(new URL(links[0]).hash.slice(1)),'MNEBYVPN Германия');
  assert.equal(decodeURIComponent(new URL(links[1]).hash.slice(1)),'MNEBYVPN Нидерланды');
  assert.equal(new URL(links[0]).search,new URL(de.profile_uri).search);
  assert.ok(!links[0].includes(de.signature));
  assert.equal(verifiedAdditionalVpnLinks([nl,nl],owner,pub,now.getTime()).length,1);
});

test('unsigned, tampered, expired or revoked node is not published',()=>{
  const good=receipt();
  const scenarios:AdditionalNodeReceipt[]=[
    {...good,country_code:'DE'}, // changed after signing
    {...good,endpoint_host:'attack.example.net'},
    {...good,profile_uri:good.profile_uri.replace('security=reality','security=none')},
    {...good,profile_uri:good.profile_uri+'&allowInsecure=true'},
    {...good,entitlement_id:'00000000-0000-4000-8000-000000000000'},
    {...good,revision:4},
    {...good,signature:'0'.repeat(86)},
    signed({country_code:'DE',country_name_ru:'Нидерланды'}),
    signed({state:'degraded'}),
    signed({state:'disabled'}),
    signed({verified_at:new Date(now.getTime()-61*60_000)}),
    signed({observed_at:new Date(now.getTime()-16*60_000)}),
    signed({expires_at:new Date(expiresAt.getTime()-2000)}),
    signed({profile_uri:good.profile_uri.replace('nl-node-02','127.0.0.1')}),
    signed({country_code:'ZZ'}),
    signed({
      endpoint_host:'bad.-invalid.example.net',
      profile_uri:good.profile_uri.replace('nl-node-02.nodes.example.net',
        'bad.-invalid.example.net'),
    }),
    signed({
      endpoint_host:'bad.invalid-.example.net',
      profile_uri:good.profile_uri.replace('nl-node-02.nodes.example.net',
        'bad.invalid-.example.net'),
    }),
    signed({profile_uri:good.profile_uri.replace(
      'sni=www.cloudflare.com','sni=bad.-invalid.example.net')}),
  ];
  for(const item of scenarios){
    assert.deepEqual(verifiedAdditionalVpnLinks([item],owner,pub,now.getTime()),[],
      item.country_code+'/'+item.state+'/'+item.profile_uri);
  }
  assert.deepEqual(verifiedAdditionalVpnLinks([good],owner,pub,expiresAt.getTime()),[]);
  assert.deepEqual(verifiedAdditionalVpnLinks([good],
    {...owner,revision:4},pub,now.getTime()),[]);
});

test('identity, expiry and website key all must agree; never trust arbitrary DB text',()=>{
  const entry=receipt();
  assert.equal(verifiedAdditionalVpnLinks([entry],owner,pub,now.getTime()).length,1);
  // Ed25519 signatures are 64 bytes => the final unpadded base64url
  // character has four unused bits. Different text for the SAME signature
  // bytes is still rejected to keep audit logs/receipts canonical.
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const end=alphabet.indexOf(entry.signature.at(-1)??'');
  assert.ok(end>=0);
  const nonCanonical=entry.signature.slice(0,-1)+
    alphabet[(end&~15)|((end+1)&15)];
  assert.notEqual(nonCanonical,entry.signature);
  assert.deepEqual(verifiedAdditionalVpnLinks([
    {...entry,signature:nonCanonical},
  ],owner,pub,now.getTime()),[]);
  const foreign=generateKeyPairSync('ed25519');
  const foreignPub=additionalNodeVerificationKey(
    foreign.publicKey.export({format:'der',type:'spki'}).toString('base64url'));
  assert.deepEqual(verifiedAdditionalVpnLinks([entry],owner,foreignPub,now.getTime()),[]);
  assert.throws(()=>additionalNodeVerificationKey('not-a-key'));
  assert.throws(()=>verifiedAdditionalVpnLinks(Array(21).fill(entry),owner,pub,now.getTime()));
});
