import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  germanWebSocketOnly,incySubscriptionHeaders,INCY_SITE_URL,
  INCY_BOT_URL,INCY_SUPPORT_URL,
} from '../packages/provisioning/src/incy-subscription-presentation.ts';

const userId='11111111-2222-4333-8444-555555555555';
const host='cdn.servgo.ru';
const ws='vless://'+userId+'@'+host+':8443?'+
  'encryption=none&security=tls&type=ws&host='+host+
  '&sni='+host+'&path=%2Fmnebyvpn-vpn%2Fws#Germany%20WebSocket';
const reality=(fp:string)=>'vless://'+userId+'@'+host+':2053?'+
  'encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision&'+
  'sni=www.cloudflare.com&fp='+fp+
  '&pbk=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&sid=1111111111111111&spx=%2F';

test('three-transport and old two-transport worker outputs advertise only Germany WS',()=>{
  for(const upstream of [ws,[reality('chrome'),ws].join('\n'),
    [reality('chrome'),reality('firefox'),ws].join('\n')]){
    const result=germanWebSocketOnly(upstream);
    assert.equal(result.split('\n').length,1);
    assert.equal(result.includes('reality'),false);
    assert.equal(result.includes('2053'),false);
    const actual=new URL(result),original=new URL(ws);
    assert.equal(actual.username,original.username);
    assert.equal(actual.hostname,'cdn.servgo.ru');
    assert.equal(actual.port,'8443');
    assert.equal(actual.search,original.search);
    assert.equal(decodeURIComponent(actual.hash.slice(1)),
      '🇩🇪 MNEBYVPN · Германия · WebSocket');
  }
});
test('reject publishing an absent or duplicated WebSocket transport',()=>{
  assert.throws(()=>germanWebSocketOnly(reality('chrome')));
  assert.throws(()=>germanWebSocketOnly(ws+'\n'+ws));
  assert.throws(()=>germanWebSocketOnly('garbage'));
});
test('INCY metadata uses exact paid or trial entitlement expiry in Unix seconds',()=>{
  for(const value of ['2026-11-20T22:25:00.000Z',
    '2026-12-20T19:25:00.000Z','2099-01-01T00:00:00.000Z']){
    const expiry=new Date(value);
    const h=incySubscriptionHeaders(expiry);
    const expected=Math.floor(expiry.getTime()/1000);
    assert.equal(h['subscription-userinfo'],
      'upload=0;download=0;total=0;expire='+expected);
    assert.equal(h['profile-title'],
      'base64:'+Buffer.from('MNEBYVPN').toString('base64'));
    assert.equal(h['profile-update-interval'],'1');
    assert.equal(h['profile-web-page-url'],INCY_SITE_URL);
    assert.equal(h['support-url'],INCY_SUPPORT_URL);
    assert.equal(h['premium-url'],INCY_BOT_URL);
    assert.equal(h['support-url'],'https://t.me/MNEBYVPN_bot?start=support');
  }
  assert.throws(()=>incySubscriptionHeaders(new Date(NaN)));
  assert.throws(()=>incySubscriptionHeaders(new Date(0)));
});
test('canonical GET /sub uses same metadata for every entitlement and keeps FI AWG',()=>{
  const site=readFileSync(
    new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  assert.ok(site.includes('germanWebSocketOnly(nodeProfile)'));
  assert.ok(site.includes('incySubscriptionHeaders(owner.expiresAt)'));
  assert.ok(site.includes('verifiedIncyAwgLine(material,identity)'));
  assert.ok(site.includes('...extraProfiles'));
  assert.ok(site.includes('...(fiProfile?[fiProfile]:[])'));
  assert.ok(!site.includes('stableMultiClientVpnProfile(nodeProfile)'));
  assert.ok(site.includes("if(!validNodeVpnProfile(profile))"));
  assert.ok(site.includes("subscriptionOwner(subscriptionPool,subMatch[1])"));
});
