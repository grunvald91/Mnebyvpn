import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  parseRegionalPersonalDnsHostname,
  proposeRegionalPersonalDnsIdentity,
  regionalDnsDisplayLabel,
} from '../packages/dns-policy/src/regional-personal-dot-identity.ts';
import {parsePersonalDoTHostname}
  from '../packages/dns-policy/src/personal-dot-identity.ts';

test('Finland and Germany are distinct personal DNS names and credential identities',()=>{
  const entropy=new Uint8Array(16);
  const fi=proposeRegionalPersonalDnsIdentity('FI',entropy);
  const de=proposeRegionalPersonalDnsIdentity('DE',entropy);
  assert.equal(fi.hostname,'000000000000.fi.dns.mnebyvpn.site');
  assert.equal(de.hostname,'000000000000.de.dns.mnebyvpn.site');
  assert.notEqual(fi.hostname,de.hostname);
  assert.notEqual(fi.tokenSha256,de.tokenSha256);
  assert.equal(fi.tokenSha256,createHash('sha256')
    .update('MNEBYVPN_COUNTRY_DNS_V1\0FI\0'+fi.label,'ascii')
    .digest('hex'));
  assert.equal(fi.readyForCustomerRelease,false);
  assert.equal(de.readyForCustomerRelease,false);
  assert.deepEqual(parseRegionalPersonalDnsHostname(fi.hostname),
    {countryCode:'FI',label:'000000000000'});
  assert.deepEqual(parseRegionalPersonalDnsHostname(de.hostname),
    {countryCode:'DE',label:'000000000000'});
  assert.equal(regionalDnsDisplayLabel('FI'),'🇫🇮 Финляндия');
  assert.equal(regionalDnsDisplayLabel('DE'),'🇩🇪 Германия');
});

test('legacy personal DNS identities remain separate and unchanged',()=>{
  const legacy='000000000000.dns.mnebyvpn.site';
  assert.equal(parsePersonalDoTHostname(legacy),'000000000000');
  assert.equal(parseRegionalPersonalDnsHostname(legacy),null);
  assert.equal(parsePersonalDoTHostname(
    '000000000000.fi.dns.mnebyvpn.site'),null);
});

test('reject unapproved regions and malicious or ambiguous DNS hostnames',()=>{
  assert.throws(()=>proposeRegionalPersonalDnsIdentity('FR' as never));
  assert.throws(()=>proposeRegionalPersonalDnsIdentity('fi' as never));
  assert.throws(()=>proposeRegionalPersonalDnsIdentity('DE',new Uint8Array(14)));
  assert.equal(parseRegionalPersonalDnsHostname(
    '000000000000.FI.DNS.MNEBYVPN.SITE. ') ,null);
  const valid='abcdefgh1234.fi.dns.mnebyvpn.site';
  assert.deepEqual(parseRegionalPersonalDnsHostname(valid.toUpperCase()+'.'),
    {countryCode:'FI',label:'abcdefgh1234'});
  for(const bad of [
    valid+'.example.com','evil.'+valid,
    'https://'+valid,valid+':853','*.'+valid,
    valid+'/dns-query',' '+valid,valid+'\\path',
    'short.fi.dns.mnebyvpn.site',
    'a'.repeat(13)+'.fi.dns.mnebyvpn.site',
    'abcdefgh1234.fr.dns.mnebyvpn.site',
    'abcdefgh1234.fi.de.dns.mnebyvpn.site',
    'abcdefgh1234.fi.dns.mnebyvpn.site:853',
  ])assert.equal(parseRegionalPersonalDnsHostname(bad),null,bad);
});

test('region construction never implies live certificate or node release',()=>{
  for(let i=0;i<40;i++){
    const candidate=proposeRegionalPersonalDnsIdentity(i%2?'FI':'DE');
    assert.match(candidate.label,/^[a-z0-9]{12}$/);
    assert.match(candidate.tokenSha256,/^[a-f0-9]{64}$/);
    assert.equal(candidate.readyForCustomerRelease,false);
  }
});
