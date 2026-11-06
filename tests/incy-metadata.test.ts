import test from 'node:test';
import assert from 'node:assert/strict';
import {
  incyMetadata,expiredIncyBody,INCY_RENEW_URL,INCY_SITE_URL,INCY_SUPPORT_URL,
} from '../packages/provisioning/src/incy-metadata.ts';

const fromB64=(raw:string)=>Buffer.from(raw.slice('base64:'.length),'base64').toString('utf8');

test('INCY publishes a subscription homepage, bot support and self-service renewal',()=>{
  const expiry=new Date('2026-12-20T20:00:00Z');
  const headers=incyMetadata(expiry,expiry.getTime()-4*24*3600_000);
  assert.equal(headers['profile-title'],'MNEBYVPN');
  assert.equal(headers['profile-web-page-url'],INCY_SITE_URL);
  assert.equal(headers['support-url'],INCY_SUPPORT_URL);
  assert.equal(headers['premium-url'],INCY_RENEW_URL);
  assert.equal(headers['expiry-banner-button-url'],INCY_RENEW_URL);
  assert.equal(fromB64(headers['expiry-banner-button-text']),'Продлить доступ');
  assert.equal(headers['profile-update-interval'],'1');
  assert.equal(headers['subscription-userinfo'].split('expire=')[1],
    String(Math.floor(expiry.getTime()/1000)));
  assert.equal(headers.announce,undefined);
  assert.equal(headers['banner-button-url'],INCY_RENEW_URL);
  assert.match(fromB64(headers['banner-text']),/оплатить VPN/);
});

test('INCY announces imminent expiry and directs clients to website',()=>{
  const expiry=new Date('2026-12-20T20:00:00Z');
  const h=incyMetadata(expiry,expiry.getTime()-2*24*3600_000);
  assert.match(fromB64(h.announce),/скоро закончится/);
  assert.equal(h['announce-url'],INCY_RENEW_URL);
});

test('INCY expired profile keeps navigation without leaking a usable node',()=>{
  const expiry=new Date('2026-12-20T20:00:00Z');
  const h=incyMetadata(expiry,expiry.getTime()+1000);
  assert.match(fromB64(h.announce),/истёк/);
  assert.equal(h['announce-url'],INCY_RENEW_URL);
  const body=Buffer.from(expiredIncyBody().trim(),'base64').toString('utf8');
  assert.match(body,/#profile-title: MNEBYVPN/);
  assert.ok(body.includes('#support-url: '+INCY_SUPPORT_URL));
  assert.ok(body.includes('#profile-web-page-url: '+INCY_SITE_URL));
  assert.ok(body.includes('#announce-url: '+INCY_RENEW_URL));
  assert.doesNotMatch(body,/vless:\/\/|vmess:\/\/|trojan:\/\//);
});

test('INCY metadata rejects malformed expiry',()=>{
  assert.throws(()=>incyMetadata(new Date('invalid')),/Invalid VPN expiration/);
});
