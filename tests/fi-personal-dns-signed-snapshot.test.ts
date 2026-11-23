import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,verify} from 'node:crypto';
import {
  signFiPersonalDnsSnapshot,fiDnsSnapshotTranscript,
  type FiDnsGrant,
} from '../packages/dns-policy/src/fi-personal-dns-signed-snapshot.ts';
import {proposeRegionalPersonalDnsIdentity} from
  '../packages/dns-policy/src/regional-personal-dot-identity.ts';

const now=Date.parse('2026-11-23T18:00:00.000Z');
const iso=(x:number)=>new Date(x).toISOString();
const grant=(hash:string,id:string):FiDnsGrant=>({
  entitlementId:id,credentialRevision:2,tokenSha256:hash,
  expiresAt:iso(now+86400_000),state:'ACTIVE',
});
const ent1='11111111-1111-4111-8111-111111111111';
const ent2='22222222-2222-4222-8222-222222222222';

test('FI snapshot validates Ed25519 and signs exact Python-compatible tuple',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const identity=proposeRegionalPersonalDnsIdentity('FI',new Uint8Array(16).fill(7));
 const a=grant(identity.tokenSha256,ent1);
 const b=grant('b'.repeat(64),ent2);
 const signed=signFiPersonalDnsSnapshot({
   revision:11,issuedAt:iso(now),validUntil:iso(now+90_000),
   grants:[b,a],
 },privateKey,now);
 assert.equal(signed.nodeId,'fi-test-01');
 assert.equal(signed.countryCode,'FI');
 assert.equal(signed.schemaVersion,1);
 assert.equal(signed.grants.length,2);
 assert.equal(signed.signature.length,86);
 const payload=fiDnsSnapshotTranscript(signed);
 assert.equal(payload.toString('utf8'),JSON.stringify([
   'MNEBYVPN_REGIONAL_DNS_SNAPSHOT_V1',
   'fi-test-01','FI',11,iso(now),iso(now+90_000),
   signed.grants.map(g=>[
     g.entitlementId,g.credentialRevision,g.tokenSha256,g.expiresAt,g.state,
   ]),
 ]));
 assert.ok(verify(null,payload,publicKey,Buffer.from(signed.signature,'base64url')));
 const tampered={...signed,countryCode:'DE' as 'FI'};
 assert.equal(verify(null,fiDnsSnapshotTranscript(tampered),
                     publicKey,Buffer.from(signed.signature,'base64url')),false);
 assert.equal(createHash('sha256').update(
   'MNEBYVPN_COUNTRY_DNS_V1\0FI\0'+identity.label,'ascii').digest('hex'),
   a.tokenSha256);
});

test('issuer refuses future and stale snapshot, invalid signer and grants',()=>{
 const {privateKey}=generateKeyPairSync('ed25519');
 const sign=(changes:Record<string,unknown>={})=>
  signFiPersonalDnsSnapshot({
   revision:1,issuedAt:iso(now),validUntil:iso(now+90_000),
   grants:[grant('a'.repeat(64),ent1)],...changes,
  },privateKey,now);
 assert.equal(sign().grants.length,1);
 assert.throws(()=>sign({revision:0}));
 assert.throws(()=>sign({validUntil:iso(now+121_000)}));
 assert.throws(()=>sign({validUntil:iso(now)}));
 assert.throws(()=>sign({issuedAt:iso(now+16_000)}));
 assert.throws(()=>sign({issuedAt:iso(now-121_000),validUntil:iso(now+90_000)}));
 assert.throws(()=>sign({grants:[grant('a'.repeat(64),ent1),
                               grant('a'.repeat(64),ent2)]}));
 assert.throws(()=>sign({grants:[grant('a'.repeat(64),ent1),
                               grant('b'.repeat(64),ent1)]}));
 assert.throws(()=>sign({grants:[grant('not-a-digest',ent1)]}));
 assert.throws(()=>sign({grants:[{...grant('a'.repeat(64),ent1),state:'UNKNOWN'}]}));
 const {publicKey}=generateKeyPairSync('ed25519');
 assert.throws(()=>signFiPersonalDnsSnapshot({
   revision:1,issuedAt:iso(now),validUntil:iso(now+90_000),grants:[],
 },publicKey,now));
});

test('strict country-bound profiles are candidate only and not published',()=>{
 const fi=proposeRegionalPersonalDnsIdentity('FI',new Uint8Array(16).fill(2));
 const de=proposeRegionalPersonalDnsIdentity('DE',new Uint8Array(16).fill(2));
 assert.ok(fi.hostname.endsWith('.fi.dns.mnebyvpn.site'));
 assert.ok(de.hostname.endsWith('.de.dns.mnebyvpn.site'));
 assert.notEqual(fi.tokenSha256,de.tokenSha256);
 assert.equal(fi.readyForCustomerRelease,false);
});
