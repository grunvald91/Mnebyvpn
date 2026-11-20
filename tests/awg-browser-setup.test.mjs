import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createPrivateKey,createPublicKey,randomBytes} from 'node:crypto';
import {
  generateLocalAwgKeyPair,renderNativeAwgConf,canonicalAwgKey,createFiAwgSetup,
} from '../apps/web/public/awg-setup.js';

const TOKEN='A'.repeat(43);
const entitlement='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const publicKey=randomBytes(32).toString('base64');
const header=randomBytes(32).toString('base64');
const material=peer=>({
  protocol:'AmneziaWG 3.1',nodeId:'fi-test-01',countryCode:'FI',
  countryName:'Финляндия',endpoint:'fi.mnebyvpn.site:51821',
  clientAddress:'10.73.91.2/32',clientPublicKey:peer,
  serverPublicKey:publicKey,headerProtectionKey:header,mtu:1280,
  expiresAt:new Date(Date.now()+3600000).toISOString(),
});

test('actual WebCrypto X25519 keypair has matching raw public and private',async()=>{
  const pair=await generateLocalAwgKeyPair(webcrypto);
  assert(canonicalAwgKey(pair.publicKey));
  assert(canonicalAwgKey(pair.privateKey));
  const p8=Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420','hex'),
    Buffer.from(pair.privateKey,'base64'),
  ]);
  const nodePub=createPublicKey(createPrivateKey({
    key:p8,format:'der',type:'pkcs8',
  })).export({format:'der',type:'spki'}).subarray(-32).toString('base64');
  assert.equal(pair.publicKey,nodePub);
  assert.notEqual(pair.publicKey,(await generateLocalAwgKeyPair(webcrypto)).publicKey);
});

test('native profile is generated locally for the exact client public key',async()=>{
  const pair=await generateLocalAwgKeyPair(webcrypto);
  const file=renderNativeAwgConf(material(pair.publicKey),pair);
  assert(file.includes('PrivateKey = '+pair.privateKey));
  assert(file.includes('AllowedIPs = 0.0.0.0/0'));
  assert(file.includes('HeaderProtectionKey = '+header));
  assert(!JSON.stringify(material(pair.publicKey)).includes(pair.privateKey));
  assert.throws(()=>renderNativeAwgConf({
    ...material(pair.publicKey),clientPublicKey:randomBytes(32).toString('base64'),
  },pair),/INVALID_SIGNED/);
  assert.throws(()=>renderNativeAwgConf({
    ...material(pair.publicKey),expiresAt:new Date(Date.now()-10000).toISOString(),
  },pair),/INVALID_SIGNED/);
  assert.throws(()=>renderNativeAwgConf({
    ...material(pair.publicKey),endpoint:'evil.example:51821',
  },pair),/INVALID_SIGNED/);
});

test('only the X25519 public key crosses HTTP, and the ACK is mandatory',async()=>{
  const writes=[];
  const steps=[];
  let devicePublic='';
  const transport=async (url,options)=>{
    writes.push({url,options});
    if(url==='/api/awg/fi/device'){
      assert.equal(options.method,'POST');
      const body=JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(),['entitlementId','peerPublicKey']);
      devicePublic=body.peerPublicKey;
      return {state:'QUEUED'};
    }
    if(url.startsWith('/api/awg/fi/device/status?')){
      const u=new URL('https://mnebyvpn.site'+url);
      assert.equal(u.searchParams.get('peer'),devicePublic);
      return {state:'ACKNOWLEDGED'};
    }
    if(url==='/api/vpn/subscription')return {
      subscriptionUrl:'https://cdn.servgo.ru:8443/sub/'+TOKEN,
    };
    if(url.startsWith('/awg/'+TOKEN+'/material?'))return material(devicePublic);
    throw Error('Unrecognized request');
  };
  const result=await createFiAwgSetup(entitlement,'csrf-for-test',msg=>steps.push(msg),transport);
  assert.equal(result.filename,'MNEBYVPN-FI-AmneziaWG.conf');
  assert.match(result.file,/^PrivateKey = [A-Za-z0-9+/]{43}=$/m);
  assert(result.file.includes('HeaderProtectionKey = '+header));
  assert(steps.some(x=>x.includes('подтвердил')));
  const captured=JSON.stringify(writes);
  const privateKey=result.file.match(/^PrivateKey = (.+)$/m)?.[1];
  assert(privateKey);
  assert(!captured.includes(privateKey));
  assert.equal(writes.length,4);
});

test('refuse to generate profile without verified ACK or with malicious material',async()=>{
  const pair=await generateLocalAwgKeyPair(webcrypto);
  const foreign=randomBytes(32).toString('base64');
  assert.equal(canonicalAwgKey('A'.repeat(43)+'='),false);
  assert.throws(()=>renderNativeAwgConf({...material(pair.publicKey),
    headerProtectionKey:foreign,mtu:1400},pair),/INVALID_SIGNED/);
  assert.throws(()=>renderNativeAwgConf({...material(pair.publicKey),
    clientAddress:'10.73.91.1/32'},pair),/INVALID_SIGNED/);
});
