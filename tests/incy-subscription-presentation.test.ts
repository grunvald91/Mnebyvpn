import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  germanWebSocketOnly,keepSupportedAdditionalTransport,
  incySubscriptionHeaders,incyExpiredSubscriptionHeaders,
  incyExpiredSubscriptionBody,incyEncodeActiveSubscription,
  INCY_SITE_URL,INCY_RENEW_URL,
  INCY_SUPPORT_URL,
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
      'мне VPN Германия');
  }
});
test('reject publishing an absent or duplicated WebSocket transport',()=>{
  assert.throws(()=>germanWebSocketOnly(reality('chrome')));
  assert.throws(()=>germanWebSocketOnly(ws+'\n'+ws));
  assert.throws(()=>germanWebSocketOnly('garbage'));
});
test('signed DE Reality registry URLs are not advertised; other countries remain',()=>{
  const de='vless://'+userId+'@de.nodes.example.net:2053?security=reality&'+
    'type=tcp#'+encodeURIComponent('мне VPN Германия');
  const nl='vless://'+userId+'@nl.nodes.example.net:2053?security=reality&'+
    'type=tcp#'+encodeURIComponent('мне VPN Нидерланды');
  assert.equal(keepSupportedAdditionalTransport(de),false);
  const legacyDe=de.replace(encodeURIComponent('мне VPN Германия'),
    encodeURIComponent('🇩🇪 MNEBYVPN · Германия · de-node-02 · REALITY'));
  assert.equal(keepSupportedAdditionalTransport(legacyDe),false);
  assert.equal(keepSupportedAdditionalTransport(nl),true);
  assert.equal(keepSupportedAdditionalTransport(ws),true);
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
    assert.equal(h['profile-web-page-url'],INCY_RENEW_URL);
    assert.equal(h['homepage'],INCY_RENEW_URL);
    assert.equal(new URL(h['profile-web-page-url']).origin,INCY_SITE_URL);
    assert.equal(h['profile-description'],
      'base64:'+Buffer.from('Оплата и продление: mnebyvpn.site').toString('base64'));
    assert.equal(h['profile-web-page-url'],INCY_RENEW_URL);
    assert.equal(h['support-url'],INCY_RENEW_URL);
    assert.equal(h['premium-url'],INCY_RENEW_URL);
    assert.equal(h['announce-url'],INCY_SUPPORT_URL);
    assert.equal(new URL(h['premium-url']).origin,new URL(h['profile-web-page-url']).origin);
  }
  assert.throws(()=>incySubscriptionHeaders(new Date(NaN)));
  assert.throws(()=>incySubscriptionHeaders(new Date(0)));
});
test('canonical GET /sub uses same metadata for every entitlement and keeps FI AWG',()=>{
  const site=readFileSync(
    new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  assert.ok(site.includes('germanWebSocketOnly(nodeProfile)'));
  assert.ok(site.includes('incySubscriptionHeaders(owner.expiresAt,requestedClient)'));
  assert.ok(site.includes('incyEncodeActiveSubscription(profile,requestedClient)'));
  assert.ok(site.includes('verifiedIncyAwgLine(material,identity)'));
  // Karing and INCY share one verified FI grant: never discard AWG solely
  // because the subscription installer includes ?client=karing.
  assert.match(site,/if\(awgInSubscriptionEnabled\)\s*\{/);
  assert.doesNotMatch(site,/awgInSubscriptionEnabled\s*&&\s*requestedClient\s*!==\s*['"]karing['"]/);
  assert.ok(site.includes('...extraProfiles'));
  assert.ok(site.includes('...(fiProfile?[fiProfile]:[])'));
  assert.ok(!site.includes('stableMultiClientVpnProfile(nodeProfile)'));
  assert.ok(site.includes("if(!validNodeVpnProfile(profile))"));
  assert.ok(site.includes("subscriptionOwner(subscriptionPool,subMatch[1])"));
});

test('expired INCY subscription keeps website and bot actions with no network secrets',()=>{
  const expiry=new Date('2026-11-20T22:25:00Z');
  const headers=incyExpiredSubscriptionHeaders(expiry);
  assert.equal(headers['profile-web-page-url'],INCY_RENEW_URL);
  assert.equal(headers['premium-url'],INCY_RENEW_URL);
  assert.equal(headers['support-url'],INCY_RENEW_URL);
  assert.equal(headers['announce-url'],INCY_SUPPORT_URL);
  assert.match(Buffer.from(headers['announce'].slice(7),'base64').toString('utf8'),
    /Поддержка и связь/);
  assert.equal(headers['subscription-userinfo'].split('expire=')[1],
    String(Math.floor(expiry.getTime()/1000)));
  const decoded=Buffer.from(incyExpiredSubscriptionBody().trim(),'base64')
    .toString('utf8');
  assert.ok(decoded.includes('#profile-web-page-url: '+INCY_RENEW_URL));
  assert.ok(decoded.includes('#support-url: '+INCY_RENEW_URL));
  assert.ok(decoded.includes('#announce-url: '+INCY_SUPPORT_URL));
  assert.doesNotMatch(decoded,/vless:\/\/|vmess:\/\/|trojan:\/\/|awg:\/\/|amneziawg:\/\/|\[Interface\]/);
});


test('expired Karing navigation remains unchanged while INCY uses Site and Channel/Bot',()=>{
  const expiry=new Date('2026-11-20T22:25:00Z');
  const headers=incyExpiredSubscriptionHeaders(expiry,'karing');
  assert.equal(headers['support-url'],INCY_SUPPORT_URL);
  assert.equal(headers['announce-url'],INCY_RENEW_URL);
  assert.equal(headers['profile-web-page-url'],INCY_SITE_URL);
  const decoded=Buffer.from(incyExpiredSubscriptionBody('karing').trim(),'base64')
    .toString('utf8');
  assert.ok(decoded.includes('#profile-web-page-url: '+INCY_SITE_URL));
  assert.ok(decoded.includes('#support-url: '+INCY_SUPPORT_URL));
  assert.ok(decoded.includes('#announce-url: '+INCY_RENEW_URL));
});

test('INCY body fallback shows website and renewal while preserving signed node lines',()=>{
  const verified=[ws,'amneziawg://YWJjZA#'+encodeURIComponent('мне VPN Финляндия')].join('\n');
  const encoded=incyEncodeActiveSubscription(verified,'incy');
  const lines=Buffer.from(encoded.trim(),'base64').toString('utf8').trim().split('\n');
  assert.equal(lines[0],'#profile-title: MNEBYVPN');
  assert.ok(lines.includes('#profile-web-page-url: '+INCY_RENEW_URL));
  assert.ok(lines.includes('#support-url: '+INCY_RENEW_URL));
  assert.ok(lines.includes('#announce-url: '+INCY_SUPPORT_URL));
  const announce=lines.find(line=>line.startsWith('#announce: base64:'));
  assert.ok(announce);
  assert.match(Buffer.from(announce!.slice('#announce: base64:'.length),'base64')
    .toString('utf8'),/Связаться с поддержкой/);
  assert.deepEqual(lines.filter(line=>!line.startsWith('#')),verified.split('\n'));
  // Karing must retain the exact historical payload, byte-for-byte after decode.
  const karing=incyEncodeActiveSubscription(verified,'karing');
  assert.equal(Buffer.from(karing.trim(),'base64').toString('utf8'),verified+'\n');
  // Direct bearer subscription (no client parameter) is also imported by INCY.
  const canonical=incyEncodeActiveSubscription(verified,null);
  assert.ok(Buffer.from(canonical.trim(),'base64').toString('utf8')
    .includes('#profile-web-page-url: '+INCY_RENEW_URL));
  assert.throws(()=>incyEncodeActiveSubscription('',null));
  assert.throws(()=>incyEncodeActiveSubscription('#support-url: bad',null));
});

test('active INCY metadata provides the existing non-Premium payment action',()=>{
  const h=incySubscriptionHeaders(new Date('2026-12-20T20:00:00Z'));
  assert.equal(h['announce-url'],INCY_SUPPORT_URL);
  assert.equal(h['profile-web-page-url'],INCY_RENEW_URL);
  assert.equal(h['support-url'],INCY_RENEW_URL);
  assert.match(Buffer.from(h.announce.slice(7),'base64').toString('utf8'),
    /Связаться с поддержкой/);
  const karing=incySubscriptionHeaders(new Date('2026-12-20T20:00:00Z'),'karing');
  assert.equal(karing.announce,undefined);
  assert.equal(karing['announce-url'],undefined);
  assert.equal(karing['support-url'],INCY_SUPPORT_URL);
  assert.equal(karing['profile-web-page-url'],INCY_SITE_URL);
  assert.equal(karing['premium-url'],INCY_RENEW_URL);
});

// The Desktop client may not expose the documented website field as a button.
// Retain two actionable links in the fields the client visibly consumes.
test('INCY Desktop fallback exposes both bot and checkout without Premium',()=>{
  const date=new Date('2026-12-20T20:00:00Z');
  for(const client of [null,'incy']){
    const headers=incySubscriptionHeaders(date,client);
    assert.equal(headers['support-url'],INCY_RENEW_URL);
    assert.equal(headers['announce-url'],INCY_SUPPORT_URL);
    assert.equal(headers['profile-web-page-url'],INCY_RENEW_URL);
    assert.notEqual(headers['support-url'],headers['announce-url']);
    // Metadata cannot override the client's fixed Support button label.
    assert.equal(Object.keys(headers).some(k=>k==='support-button-text'),false);
  }
});
