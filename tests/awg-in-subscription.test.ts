import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {deriveSubscriptionAwgIdentity,verifiedIncyAwgLine}
  from '../packages/provisioning/src/awg-in-subscription.ts';
import {enqueueFiAwgActiveSubscriptions}
  from '../packages/provisioning/src/awg-device-registration-worker.ts';

const a='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const b='bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const root=randomBytes(32).toString('hex');

test('one canonical RU188 entitlement has one stable AWG key on every refresh',()=>{
  const first=deriveSubscriptionAwgIdentity(a,root);
  assert.deepEqual(deriveSubscriptionAwgIdentity(a,root),first);
  assert.notEqual(deriveSubscriptionAwgIdentity(b,root).privateKey,first.privateKey);
  assert.notEqual(deriveSubscriptionAwgIdentity(a,randomBytes(32).toString('hex')).publicKey,
    first.publicKey);
  assert.match(first.privateKey,/^[A-Za-z0-9+/]{43}=$/);
  assert.match(first.publicKey,/^[A-Za-z0-9+/]{43}=$/);
  for(const invalid of ['', '0'.repeat(64),'bad']){
    assert.throws(()=>deriveSubscriptionAwgIdentity(a,invalid));
  }
  assert.throws(()=>deriveSubscriptionAwgIdentity('invalid',root));
});

test('verified FI native config is one INCY subscription entry beside VLESS',()=>{
  const identity=deriveSubscriptionAwgIdentity(a,root);
  const pair=generateKeyPairSync('x25519');
  const pub=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
  const material={
    protocol:'AmneziaWG 3.1',nodeId:'fi-test-01',countryCode:'FI',
    countryName:'Финляндия',endpoint:'fi.mnebyvpn.site:51821',
    clientAddress:'10.73.91.2/32',clientPublicKey:identity.publicKey,
    serverPublicKey:pub,headerProtectionKey:pub,mtu:1280,
    expiresAt:'2026-12-20T12:00:00.000Z',
  } as const;
  const link=verifiedIncyAwgLine(material,identity);
  assert.match(link,/^amneziawg:\/\/[A-Za-z0-9_-]+#.+$/);
  assert.match(decodeURIComponent(link.split('#')[1]??''),/🇫🇮 MNEBYVPN/);
  const raw=Buffer.from(link.split('#')[0]!.slice('amneziawg://'.length),
    'base64url').toString('utf8');
  assert.match(raw,/^\[Interface\]\nAddress = 10\.73\.91\.2\/32/m);
  assert(raw.includes('PrivateKey = '+identity.privateKey));
  assert(raw.includes('Endpoint = fi.mnebyvpn.site:51821'));
  assert(raw.includes('HeaderProtectionKey = '+pub));
  assert(raw.includes('AllowedIPs = 0.0.0.0/0'));
  assert.throws(()=>verifiedIncyAwgLine({...material,clientPublicKey:
    deriveSubscriptionAwgIdentity(b,root).publicKey},identity));
});

test('RU188 auto-backfills all eligible subscription rights into its existing queue only',async()=>{
  const inserts:{sql:string;args:unknown[]}[]=[];
  const id1=a,id2=b;
  const db={
    query:async(sql:string,args:unknown[]=[])=>{
      if(sql.startsWith('SELECT e.id::text AS entitlement_id')){
        assert(sql.includes("f.feature='vpn_awg_clients' AND f.enabled=true"));
        assert(sql.includes("e.product='vpn' AND e.state='ACTIVE'"));
        assert(sql.includes('v.applied_revision=e.revision'));
        assert(sql.includes('NOT EXISTS(SELECT 1 FROM vpn_awg_device_requests'));
        assert.deepEqual(args,[2]);
        return {rows:[
          {entitlement_id:id1,billing_revision:'11'},
          {entitlement_id:id2,billing_revision:12},
        ],rowCount:2};
      }
      if(sql.startsWith('SELECT public.awg_controller_enqueue_fi_subscription(')){
        inserts.push({sql,args});
        return {rows:[{queued:true}],rowCount:1};
      }
      throw Error('Unexpected SQL '+sql.slice(0,60));
    },
  };
  assert.equal(await enqueueFiAwgActiveSubscriptions(db as never,root,2),2);
  assert.equal(inserts.length,2);
  assert.deepEqual(inserts[0]!.args,[a,deriveSubscriptionAwgIdentity(a,root).publicKey,11]);
  assert.deepEqual(inserts[1]!.args,[b,deriveSubscriptionAwgIdentity(b,root).publicKey,12]);
  for(const {sql} of inserts){
    assert(sql.includes('public.awg_controller_enqueue_fi_subscription('));
    assert(!/\b(?:INSERT|DELETE|UPDATE|ALTER)\b/i.test(sql));
  }
  await assert.rejects(enqueueFiAwgActiveSubscriptions(db as never,root,999));
});
