import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedPersonalDnsOffer,PERSONAL_DNS_STARS_OFFERS,
  PERSONAL_DNS_QUERIES_PER_30D} from '../packages/dns-policy/src/smart-dns-offers.ts';
test('four approved DNS prices and a single 1M-query metric',()=>{
  assert.deepEqual(PERSONAL_DNS_STARS_OFFERS.map(p=>[p.days,p.stars]),[
    [14,100],[30,200],[60,400],[90,500]]);
  assert.equal(PERSONAL_DNS_QUERIES_PER_30D,1000000n);
  for(const o of PERSONAL_DNS_STARS_OFFERS){
    const p={planId:o.planId,product:'smart_dns',durationSeconds:o.days*86400,
      stars:o.stars,dnsQuotaBytes:null,dnsQuotaQueriesPer30d:1000000n};
    assert.equal(approvedPersonalDnsOffer(p),o);
    assert.equal(approvedPersonalDnsOffer({...p,stars:o.stars+1}),null);
    assert.equal(approvedPersonalDnsOffer({...p,dnsQuotaQueriesPer30d:1000001n}),null);
    assert.equal(approvedPersonalDnsOffer({...p,product:'vpn'}),null);
    assert.equal(approvedPersonalDnsOffer({...p,dnsQuotaBytes:500n}),null);
  }
});
