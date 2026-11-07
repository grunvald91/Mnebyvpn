import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDomainRoutes, decideDomainRoute, type RouteAdmitContext }
  from '../packages/dns-policy/src/domain-routing.ts';

const safe: RouteAdmitContext = {
  policyRevision: 3, ingressHealthy: true, e2eVerified: true,
  rrPolicyVerified: true, ingressAuthorizationVerified: true,
};
const rules = compileDomainRoutes([
  {domain: 'ai.example.test', status: 'verified', verifiedPolicyRevision: 3},
  {domain: 'mail.example.test', status: 'testing'},
]);

test('unknown and unverified sites stay direct; no vendor-wide wildcard or suffix match', () => {
  assert.deepEqual(decideDomainRoute('mail.example.test', rules, safe),
    {route:'direct',reason:'not-verified'});
  assert.deepEqual(decideDomainRoute('maps.example.test', rules, safe),
    {route:'direct',reason:'unlisted-domain'});
  assert.deepEqual(decideDomainRoute('ai.example.test.evil.test', rules, safe),
    {route:'direct',reason:'unlisted-domain'});
  assert.throws(() => compileDomainRoutes([{domain:'*.example.test',status:'verified'}]), /exact/);
});
test('canary candidate only after ALL independently verified gates', () => {
  assert.deepEqual(decideDomainRoute('AI.EXAMPLE.TEST.', rules, safe),
    {route:'proxy-candidate',domain:'ai.example.test',policyRevision:3});
  for (const gate of ['ingressHealthy','e2eVerified','rrPolicyVerified','ingressAuthorizationVerified'] as const) {
    assert.equal(decideDomainRoute('ai.example.test', rules, {...safe,[gate]:false}).route,
      'direct',gate);
  }
  assert.deepEqual(decideDomainRoute('ai.example.test', rules, {...safe,policyRevision:4}),
    {route:'direct',reason:'stale-or-unverified-policy'});
});
test('duplicate or malformed domain rules are rejected rather than ambiguously applied', () => {
  assert.throws(() => compileDomainRoutes([
    {domain:'AI.example.test',status:'testing'},
    {domain:'ai.example.test.',status:'verified',verifiedPolicyRevision:3},
  ]), /Duplicate/);
  for (const name of ['', '127.0.0.1', 'test', 'a..test', 'bad:443', 'https://example.test']) {
    assert.deepEqual(decideDomainRoute(name, rules, safe),
      {route:'direct',reason:'invalid-domain'});
  }
});
test('candidate is NOT an ingress authorization or a live DNS rewrite', () => {
  const decision = decideDomainRoute('ai.example.test', rules, safe);
  assert.equal(decision.route, 'proxy-candidate');
  assert.equal('destinationIPv6' in decision,false);
  assert.equal('subscriptionId' in decision,false);
});
