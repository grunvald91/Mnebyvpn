import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {
  dnsAppleProfile,dnsHostname,dnsTokenFromSni,
  issuePersonalDnsAccess,authorizePersonalDnsQuery,
  revokePersonalDnsAccess,personalDnsAccessStatuses,
} from '../packages/dns-access/src/personal.ts';

const A='11111111-1111-4111-8111-111111111111';
const E='22222222-2222-4222-8222-222222222222';
const fake=(query:(sql:string,values:unknown[])=>Promise<{rows:any[]}>):Pick<Pool,'query'>=>
  ({query} as unknown as Pick<Pool,'query'>);

test('issued subscriber hostname is random, valid for Android and Apple profile',async()=>{
  let hashed='';
  const db=fake(async(sql,params)=>{
    assert.match(sql,/dns_issue_link_for_account/);
    assert.equal(params[0],A);
    assert.equal(params[1],E);
    assert.match(String(params[2]),/^[a-f0-9]{64}$/);
    hashed=String(params[2]);
    return {rows:[{status:'ISSUED'}]};
  });
  const result=await issuePersonalDnsAccess(db,A,E);
  assert.ok(result&&result!=='ALREADY_ISSUED');
  const hostname=result.hostname;
  const label=dnsTokenFromSni(hostname);
  assert.ok(label);
  assert.match(hostname,/^u[a-f0-9]{48}\.dns\.mnebyvpn\.site$/);
  assert.equal(hashed,createHash('sha256').update(label).digest('hex'));
  assert.equal(dnsTokenFromSni(hostname.toUpperCase()),label);
  assert.equal(dnsHostname(label),hostname);
  const profile=result.appleProfileXml;
  assert.match(profile,/<key>DNSProtocol<\/key><string>TLS<\/string>/);
  assert.ok(profile.includes('<key>ServerName</key><string>'+hostname+'</string>'));
  assert.match(profile,/<key>PayloadType<\/key><string>com\.apple\.dnsSettings\.managed<\/string>/);
  assert.doesNotMatch(profile,/<key>PayloadType<\/key><string>com\.apple\.vpn|<key>PayloadCertificateUUID<\/key>/);
});

test('token label parsing does not accept suffix tricks or arbitrary DNS labels',()=>{
  for(const bad of [
    'dns.mnebyvpn.site','example.dns.mnebyvpn.site',
    'u'+'a'.repeat(47)+'.dns.mnebyvpn.site',
    'u'+'a'.repeat(49)+'.dns.mnebyvpn.site',
    'u'+'a'.repeat(48)+'.dns.mnebyvpn.site.attacker.com',
    'x.u'+'a'.repeat(48)+'.dns.mnebyvpn.site',
    'u'+'g'.repeat(48)+'.dns.mnebyvpn.site',
    'u'+'a'.repeat(48)+'.dns.mnebyvpn.site.',
  ])assert.equal(dnsTokenFromSni(bad),null,bad);
  assert.throws(()=>dnsAppleProfile('u123'));
});

test('reissuing a lost link rotates explicit token, never exposes a stored secret',async()=>{
  const db=fake(async(sql,params)=>{
    if(sql.includes('dns_issue_link_for_account')){
      assert.equal(params[3],true);
      return {rows:[{status:'ROTATED'}]};
    }
    if(sql.includes('dns_links_for_account')){
      return {rows:[{
        entitlement_id:E,access_state:'ACTIVE',expires_at:new Date('2026-12-01'),
        link_issued_at:new Date('2026-11-12'),authorized_queries:'7',
        last_query_at:new Date('2026-11-13'),
      }]};
    }
    throw Error('unexpected query');
  });
  const issued=await issuePersonalDnsAccess(db,A,E,true);
  assert.ok(issued&&issued!=='ALREADY_ISSUED');
  assert.equal(issued.status,'ROTATED');
  const statuses=await personalDnsAccessStatuses(db,A);
  assert.deepEqual(statuses,[{
    entitlementId:E,status:'ACTIVE',
    expiresAt:'2026-12-01T00:00:00.000Z',
    issuedAt:'2026-11-12T00:00:00.000Z',
    authorizedQueries:'7',lastQueryAt:'2026-11-13T00:00:00.000Z',
  }]);
  assert.equal(JSON.stringify(statuses).includes('dns.mnebyvpn.site'),false);
});

test('unknown, denied and unreachable DNS query authorization fails closed',async()=>{
  let hits=0;
  const broken=fake(async()=>{hits++;throw Error('SQL DOWN');});
  assert.equal(await authorizePersonalDnsQuery(broken,'u123'),false);
  assert.equal(hits,0);
  assert.equal(await authorizePersonalDnsQuery(broken,'u'+'a'.repeat(48)),false);
  assert.equal(hits,1);
  const denied=fake(async()=>({rows:[{status:'DENY'}]}));
  assert.equal(await authorizePersonalDnsQuery(denied,'u'+'a'.repeat(48)),false);
});

test('SQL rejects an unauthorized link; revocation requires a verified account',async()=>{
  const db=fake(async(sql,params)=>{
    if(sql.includes('dns_issue_link_for_account'))return {rows:[{status:'DENY_NOT_PAID'}]};
    if(sql.includes('dns_revoke_link_for_account')){
      assert.deepEqual(params,[A,E]);
      return {rows:[{status:'REVOKED'}]};
    }
    return {rows:[]};
  });
  assert.equal(await issuePersonalDnsAccess(db,A,E),null);
  assert.equal(await revokePersonalDnsAccess(db,A,E),'REVOKED');
  assert.equal(await revokePersonalDnsAccess(db,'not-a-uuid',E),null);
  assert.deepEqual(await personalDnsAccessStatuses(db,'bogus'),[]);
});
