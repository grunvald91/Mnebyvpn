import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PermanentIngressAddresses, personalizeDnsAfterSharedCache,
  type DnsPolicyContext, type UpstreamAnswer,
} from '../packages/dns-policy/src/personalized.ts';

const now = new Date('2026-11-05T20:00:00Z');
const registry = new PermanentIngressAddresses();
registry.bind('sub-a', '2001:db8::a');
registry.bind('sub-b', '2001:db8::b');
const sameUpstream: UpstreamAnswer = {
  name: 'example.org', rrType: 'AAAA', values: ['2001:db8::ffff'], ttlSeconds: 300,
};
function context(packageId: string): DnsPolicyContext {
  return {
    packageId, policyRevision: 4, entitlementRevision: 7,
    authorized: true, expiresAt: new Date(now.getTime() + 3600_000),
    allowedDomains: new Set(['example.org']),
  };
}
test('two subscriptions querying the SAME domain get unique IPv6 AFTER common cache', () => {
  const a = personalizeDnsAfterSharedCache({ name: 'example.org', rrType: 'AAAA' }, sameUpstream, context('sub-a'), registry, now);
  const b = personalizeDnsAfterSharedCache({ name: 'example.org', rrType: 'AAAA' }, sameUpstream, context('sub-b'), registry, now);
  assert.equal(a.mode, 'personal-ipv6-test-only');
  assert.equal(b.mode, 'personal-ipv6-test-only');
  assert.notDeepEqual(a.answer.values, b.answer.values);
  assert.equal(a.cache, 'never-shared-no-store');
  assert.equal(b.cache, 'never-shared-no-store');
  assert.deepEqual(sameUpstream.values, ['2001:db8::ffff']);
});
test('revoked IPv6 is permanently tombstoned, even after every DNS TTL', () => {
  const original = '2001:db8::a';
  registry.revoke('sub-a');
  assert.equal(registry.packageForIngressIP(original), null);
  assert.throws(() => registry.bind('sub-c', original), /permanently assigned/);
  assert.throws(() => registry.bind('sub-c', '2001:0db8:0:0:0:0:0:a'), /permanently assigned/);
  assert.throws(() => registry.bind('sub-a', '2001:db8::c'), /Changing an assigned|Revoked/);
  const answer = personalizeDnsAfterSharedCache({ name: 'example.org', rrType: 'AAAA' }, sameUpstream, context('sub-a'), registry, now);
  assert.equal(answer.mode, 'upstream');
});
test('bearer address is bound to package, not source device, and unknown addresses are denied', () => {
  assert.equal(registry.packageForIngressIP('2001:db8::b'), 'sub-b');
  assert.equal(registry.packageForIngressIP('2001:db8::123'), null);
  assert.throws(() => registry.bind('sub-c', '1.2.3.4'));
});
test('never cache personal answers in a shared cache; other RR and invalid rights pass through', () => {
  const b = context('sub-b');
  const cases = [
    { ...b, authorized: false },
    { ...b, expiresAt: new Date(now.getTime() - 1) },
    { ...b, allowedDomains: new Set(['other.org']) },
  ];
  for (const item of cases) {
    const result = personalizeDnsAfterSharedCache({ name: 'example.org', rrType: 'AAAA' }, sameUpstream, item, registry, now);
    assert.equal(result.mode, 'upstream');
    assert.deepEqual(result.answer.values, sameUpstream.values);
  }
  const aAnswer: UpstreamAnswer = { name: 'example.org', rrType: 'A', values: ['203.0.113.2'], ttlSeconds: 30 };
  const other = personalizeDnsAfterSharedCache({ name: 'example.org', rrType: 'A' }, aAnswer, b, registry, now);
  assert.equal(other.mode, 'upstream');
});
