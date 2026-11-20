import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGscOwnerRelaySignature,verifyGscOwnerRelaySignature,validGscOwnerReport,
} from '../packages/support/src/gsc-owner-relay.ts';

const token='123456:abcdefghijklmnopqrstuvwxyzABCDEFGH';
const text='MNEBYVPN · Google Search Console\n2026-11-01 — 2026-11-20\nПоказы: 120\nКлики: 7';
const now=1_800_000_000_000;
const ts=String(Math.floor(now/1000));
test('GSC owner relay binds private summary and timestamp to the existing token',()=>{
  const signature=createGscOwnerRelaySignature(token,ts,text);
  assert.match(signature,/^[a-f0-9]{64}$/);
  assert.ok(verifyGscOwnerRelaySignature(token,ts,signature,text,now));
  assert.equal(verifyGscOwnerRelaySignature(token,ts,signature,text+' spam',now),false);
  assert.equal(verifyGscOwnerRelaySignature(token,ts,signature+'ff',text,now),false);
  assert.equal(verifyGscOwnerRelaySignature(token+'x',ts,signature,text,now),false);
  assert.equal(verifyGscOwnerRelaySignature(token,ts,signature,text,now+121_000),false);
  assert.equal(verifyGscOwnerRelaySignature(token,'foo',signature,text,now),false);
  assert.equal(verifyGscOwnerRelaySignature('',ts,signature,text,now),false);
});
test('owner relay rejects unrelated text, oversized input, control characters',()=>{
  assert.equal(validGscOwnerReport('SEO report'),false);
  assert.equal(validGscOwnerReport(text),true);
  assert.equal(validGscOwnerReport(text+'\u0000'),false);
  assert.equal(validGscOwnerReport(text+'x'.repeat(4000)),false);
  assert.throws(()=>createGscOwnerRelaySignature(token,ts,'SEO report'),/GSC_OWNER_RELAY_INVALID_INPUT/);
});
