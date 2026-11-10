import test from 'node:test';
import assert from 'node:assert/strict';
import {makePersonalStarsLinkPayload,parsePersonalStarsLinkPayload}
  from '../packages/billing/src/stars-links.ts';
import {parseStarsPayload} from '../packages/billing/src/stars.ts';
const secret='a-secret-long-enough-for-stable-HMAC-signature-and-entropy';
test('personal invoice payload binds order UUID, Telegram user, offer fingerprint, HMAC',()=>{
 const payload=makePersonalStarsLinkPayload(4198221122,'Aa1234_____9999_',secret);
 assert.ok(Buffer.byteLength(payload,'utf8')<=128);
 const x=parsePersonalStarsLinkPayload(payload,secret);
 assert.ok(x);
 assert.equal(x.telegramUserId,4198221122);
 assert.equal(x.offerKey,'Aa1234_____9999_');
 assert.equal(parseStarsPayload(payload,secret),x.orderId);
 const tampered=payload.split(':');tampered[4]=(4198221123).toString(36);
 assert.equal(parsePersonalStarsLinkPayload(tampered.join(':'),secret),null);
 const b=payload.split(':');
 b[3]='1';assert.equal(parsePersonalStarsLinkPayload(b.join(':'),secret),null);
 assert.equal(parsePersonalStarsLinkPayload(payload,secret+'changed'),null);
 assert.equal(parsePersonalStarsLinkPayload(payload.slice(0,-1)+(payload.endsWith('0')?'1':'0'),secret),null);
 assert.throws(()=>makePersonalStarsLinkPayload(0,x.offerKey,secret),/Invalid/);
 assert.throws(()=>makePersonalStarsLinkPayload(x.telegramUserId,'INVALID',secret),/Invalid/);
});
