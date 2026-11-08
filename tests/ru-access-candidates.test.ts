import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDomainRoutes,decideDomainRoute} from '../packages/dns-policy/src/domain-routing.ts';
import {ruAccessCandidates,directOnlyRussianServices} from '../packages/dns-policy/src/ru-access-candidates.ts';

test('catalog is explicit and never treated as a live admission',()=>{
  assert.ok(ruAccessCandidates.length>=20);
  const compiled=compileDomainRoutes(ruAccessCandidates);
  assert.equal(compiled.size,ruAccessCandidates.length);
  for(const candidate of ruAccessCandidates){
    assert.equal(candidate.deployment,'research-only');
    assert.match(candidate.evidenceUrl,/^https:\/\//);
    assert.notEqual(candidate.status,'verified');
    assert.equal(candidate.verifiedPolicyRevision,undefined);
    assert.equal(decideDomainRoute(candidate.domain,compiled,{
      policyRevision:1,ingressHealthy:true,e2eVerified:true,
      rrPolicyVerified:true,ingressAuthorizationVerified:true,
    }).route,'direct',candidate.domain);
  }
});
test('no wildcard or Russian-only service gets added to candidate routing',()=>{
  const compiled=compileDomainRoutes(ruAccessCandidates);
  for(const domain of directOnlyRussianServices){
    assert.equal(compiled.has(domain),false,domain);
  }
  for(const domain of ['discord.com.evil.com','*.discord.com','ru','www.gov.ru']){
    assert.equal(compiled.has(domain),false,domain);
  }
});
test('high-signal research spans multiple services, not just Google',()=>{
  const serviceNames=new Set(ruAccessCandidates.map(d=>d.service));
  for(const service of ['Discord','Meta','OpenAI','YouTube','Bluesky','X']){
    assert.ok(serviceNames.has(service),service);
  }
});
