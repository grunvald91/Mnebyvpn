import test from 'node:test';
import assert from 'node:assert/strict';
import {
  websitePersonalDnsStatus,issueWebsitePersonalDnsProfile
} from '../packages/web/src/personal-dns-apple.ts';

const session='a'.repeat(64);
const entitlement='11111111-1111-4111-8111-111111111111';
test('status is fetched by session digest, never an anonymous account or host label',async()=>{
  let called=0;
  const db={async query(sql:string,args:unknown[]){
    called++;
    assert.match(sql,/website_personal_dns_status/);
    assert.deepEqual(args,[session,entitlement]);
    return {rows:[{status:{issued:false,revision:null,revoked:false}}]};
  }};
  assert.deepEqual(await websitePersonalDnsStatus(db as never,session,entitlement),
    {issued:false,revision:null,revoked:false});
  assert.equal(called,1);
  assert.equal(await websitePersonalDnsStatus(db as never,'unsafe',entitlement),null);
  assert.equal(called,1);
});
test('only verified issue produces personalized Apple DNS profile',async()=>{
  const db={async query(sql:string,args:unknown[]){
    assert.match(sql,/website_issue_personal_dns_credential/);
    assert.equal(args[0],session);assert.equal(args[1],entitlement);
    assert.match(String(args[2]),/^[a-z0-9]{12}$/);
    assert.match(String(args[3]),/^[0-9a-f]{64}$/);
    return {rows:[{code:'ISSUED'}]};
  }};
  const result=await issueWebsitePersonalDnsProfile(db as never,session,entitlement,'issue');
  assert.equal(result.kind,'ready');
  if(result.kind!=='ready')return;
  assert.match(result.xml,/com\.apple\.dnsSettings\.managed/);
  assert.match(result.xml,/dns\.mnebyvpn\.site/);
  assert.match(result.xml,/DNSProtocol<\/key><string>TLS/);
  assert.ok(!result.xml.includes('VPNType'));
});
test('a second request is refused; rotation requires matching revision',async()=>{
  const codes=['DENY_ALREADY_ASSIGNED','DENY_STALE','ROTATED'];
  const db={async query(sql:string,args:unknown[]){
    if(args.length===5){
      assert.match(sql,/website_rotate_personal_dns_credential/);
      assert.equal(args[2],4);
    }
    return {rows:[{code:codes.shift()}]};
  }};
  assert.deepEqual(await issueWebsitePersonalDnsProfile(db as never,session,entitlement,'issue'),
    {kind:'already-issued'});
  assert.deepEqual(await issueWebsitePersonalDnsProfile(db as never,session,entitlement,'rotate',4),
    {kind:'stale'});
  assert.equal((await issueWebsitePersonalDnsProfile(db as never,session,entitlement,'rotate',4)).kind,'ready');
  assert.deepEqual(await issueWebsitePersonalDnsProfile(db as never,session,entitlement,'rotate',0),
    {kind:'inactive'});
});
test('never release a profile without paid, current, owner-authorized DB result',async()=>{
  const db={async query(){return {rows:[{code:'DENY_OWNER'}]}}};
  assert.deepEqual(await issueWebsitePersonalDnsProfile(db as never,session,entitlement,'issue'),
    {kind:'inactive'});
  assert.deepEqual(await issueWebsitePersonalDnsProfile(db as never,session,'bad','issue'),
    {kind:'inactive'});
});

test('FI status and issue use the same authenticated entitlement, not DE rotation',async()=>{
  const db={async query(sql:string,args:unknown[]){
    assert.deepEqual(args.slice(0,2),[session,entitlement]);
    if(sql.includes('website_regional_dns_status'))return {rows:[{status:{issued:false,revision:null,revoked:false}}]};
    assert.match(sql,/website_issue_regional_dns_credential/);
    assert.match(String(args[2]),/^[a-z0-9]{12}$/);
    assert.equal(args[3],0);
    return {rows:[{code:'ISSUED'}]};
  }};
  assert.deepEqual(await websitePersonalDnsStatus(db as never,session,entitlement,'FI'),{issued:false,revision:null,revoked:false});
  const result=await issueWebsitePersonalDnsProfile(db as never,session,entitlement,'issue',undefined,'FI');
  assert.equal(result.kind,'ready');
  if(result.kind==='ready'){
    assert.match(result.hostname,/^[a-z0-9]{12}\.fi\.mnebyvpn\.site$/);
    assert.ok(result.xml.includes(result.hostname));
  }
});
test('FI rotation carries only the expected FI revision; denied ownership never yields a bearer',async()=>{
  const db={async query(sql:string,args:unknown[]){
    assert.match(sql,/website_issue_regional_dns_credential/);
    assert.equal(args[3],3);
    return {rows:[{code:'DENY_OWNER'}]};
  }};
  assert.deepEqual(await issueWebsitePersonalDnsProfile(db as never,session,entitlement,'rotate',3,'FI'),{kind:'inactive'});
});
