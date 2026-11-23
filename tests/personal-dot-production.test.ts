import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCachedOwnerLinkStatus,dotPoolMaxConnections,ownerStatusCacheMs,
  privateBindIp,runPersonalDotProduction,personalDotPort,
} from '../apps/service/src/personal-dot-production.ts';

test('production personal DNS can only bind loopback or RFC1918 private IPv4',()=>{
  for(const ip of ['127.0.0.1','10.77.0.1','172.16.0.2','172.31.255.200','192.168.50.3'])
    assert.equal(privateBindIp(ip),true,ip);
  for(const ip of ['0.0.0.0','::','::1','188.120.254.223','89.125.90.101',
    '172.32.0.1','172.15.0.1','192.169.0.1','127.0.0.2','abc','10.1.1.999'])
    assert.equal(privateBindIp(ip),false,ip);
});

test('no opt-in switch means no gateway sockets, no DB and no accidental production',async()=>{
  const oldEnv=process.env.MNEBYVPN_ENV,oldFlag=process.env.MNEBYDNS_PERSONAL_DOT_ENABLED;
  try{
    process.env.MNEBYVPN_ENV='production';
    delete process.env.MNEBYDNS_PERSONAL_DOT_ENABLED;
    await assert.rejects(runPersonalDotProduction(),/not explicitly enabled/);
    process.env.MNEBYDNS_PERSONAL_DOT_ENABLED='no';
    await assert.rejects(runPersonalDotProduction(),/not explicitly enabled/);
  }finally{
    if(oldEnv===undefined)delete process.env.MNEBYVPN_ENV;
    else process.env.MNEBYVPN_ENV=oldEnv;
    if(oldFlag===undefined)delete process.env.MNEBYDNS_PERSONAL_DOT_ENABLED;
    else process.env.MNEBYDNS_PERSONAL_DOT_ENABLED=oldFlag;
  }
});

test('public gateway binds unprivileged port while standard DoT upstream permits 853',()=>{
  assert.equal(personalDotPort(8853),8853);
  assert.throws(()=>personalDotPort(853),/Unsafe personal DoT port/);
  assert.equal(personalDotPort(853,1),853);
  assert.equal(personalDotPort(443,1),443);
  assert.throws(()=>personalDotPort(0,1),/Unsafe personal DoT port/);
  assert.throws(()=>personalDotPort(65536,1),/Unsafe personal DoT port/);
});

test('DoT pool connection limit validates canary range 1..8 and defaults to 4',()=>{
  assert.equal(dotPoolMaxConnections(undefined),4);
  assert.equal(dotPoolMaxConnections(''),4);
  assert.equal(dotPoolMaxConnections('8'),8);
  assert.equal(dotPoolMaxConnections('1'),1);
  for(const bad of ['0','9','-1','4.5','abc']){
    assert.throws(()=>dotPoolMaxConnections(bad),/Unsafe DoT pool connection limit/);
  }
});

test('owner DNS link status cache is positive-only, bounded and respects TTL',async()=>{
  assert.equal(ownerStatusCacheMs(undefined),30000);
  assert.equal(ownerStatusCacheMs('0'),0);
  assert.equal(ownerStatusCacheMs('60000'),60000);
  for(const bad of ['-1','60001','abc']){
    assert.throws(()=>ownerStatusCacheMs(bad),/Unsafe owner DNS status cache TTL/);
  }
  let clock=1000;
  let calls=0;
  let current='ALLOWED_SMART_DNS';
  const cached=createCachedOwnerLinkStatus(async()=>{calls++;return current;},30000,()=>clock,2);
  assert.equal(await cached('aaaaaaaaaaaa'),'ALLOWED_SMART_DNS');
  assert.equal(await cached('aaaaaaaaaaaa'),'ALLOWED_SMART_DNS');
  assert.equal(calls,1);
  clock=31000;
  current='DENY_INACTIVE';
  assert.equal(await cached('aaaaaaaaaaaa'),'DENY_INACTIVE');
  assert.equal(calls,2);
  // Denials must never be cached.
  current='ALLOWED';
  assert.equal(await cached('aaaaaaaaaaaa'),'ALLOWED');
  assert.equal(calls,3);
  // Bound max entries to 2.
  assert.equal(await cached('bbbbbbbbbbbb'),'ALLOWED');
  assert.equal(await cached('cccccccccccc'),'ALLOWED');
  assert.equal(calls,5);
  assert.equal(await cached('aaaaaaaaaaaa'),'ALLOWED');
  assert.equal(calls,6);
});
