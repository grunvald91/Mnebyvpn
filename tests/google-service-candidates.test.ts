import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDomainRoutes, decideDomainRoute} from '../packages/dns-policy/src/domain-routing.ts';
import {googleRouteCandidates,googleRoutePolicyIsLive} from '../packages/dns-policy/src/google-service-candidates.ts';

test('Google candidate list cannot enable any real foreign proxy route', () => {
  assert.equal(googleRoutePolicyIsLive,false);
  const rules=compileDomainRoutes(googleRouteCandidates);
  assert.equal(rules.size,googleRouteCandidates.length);
  for(const item of googleRouteCandidates) {
    assert.notEqual(item.status,'verified',item.domain);
    assert.equal(item.verifiedPolicyRevision,undefined);
    const decision=decideDomainRoute(item.domain,rules,{
      policyRevision:1,
      ingressHealthy:true,
      e2eVerified:true,
      rrPolicyVerified:true,
      ingressAuthorizationVerified:true,
    });
    assert.equal(decision.route,'direct',item.domain);
  }
});

test('Google base domain and fabricated subdomains are not wildcard allowed', () => {
  const rules=compileDomainRoutes(googleRouteCandidates);
  for(const name of ['google.com','aistudio.google.com.evil.test','random.googleapis.com','x.googlevideo.com']) {
    assert.equal(rules.has(name),false);
  }
});
