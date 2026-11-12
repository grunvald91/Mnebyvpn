import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateDestinationIPv6,isWithinDelegated64,ipv6PaidLaunchCandidate,
  parseGlobalDelegated64,
} from '../packages/dns-policy/src/paid-ipv6-prefix.ts';
import {
  authorizeSniIngress,MeteredChunkGate,
  type TrustedEntitlement,type IngressAdmission,
} from '../packages/dns-policy/src/paid-ingress-gate.ts';

const prefix='2a03:1234:5678:abcd::/64';
const a='11111111-1111-4111-8111-111111111111';
const b='22222222-2222-4222-8222-222222222222';
const key=Buffer.alloc(32,41);
const ip=candidateDestinationIPv6(prefix,a,key);
function grant(overrides:Partial<TrustedEntitlement>={}):TrustedEntitlement{
  return {
    entitlementId:a,destinationIPv6:ip,product:'smart_dns',state:'ACTIVE',
    revision:3,expiresAt:new Date('2027-01-01T00:00:00Z'),
    quotaState:'AVAILABLE',quotaRemainingBytes:100_000n,retiredAt:null,
    ...overrides,
  };
}
const allow=new Set(['claude.ai','api.anthropic.com']);
const now=new Date('2026-11-12T00:00:00Z');
function admit(g:TrustedEntitlement|null=grant(),dest=ip,sni='claude.ai',p:string|null=prefix){
  return authorizeSniIngress(dest,sni,p,g,allow,now);
}

test('require an aligned global /64 and reject non-public or different masks',()=>{
  assert.equal(parseGlobalDelegated64(prefix),prefix);
  for(const bad of [
    '2001:db8::/64','fe80::/64','fc00::/64','ff00::/64','::/64',
    '2a03:1234:5678:abcd::/56','2a03:1234:5678:abcd::1/64',
    'not-a-prefix','2a03:1234:5678:abcd::/128',
  ])assert.throws(()=>parseGlobalDelegated64(bad),bad);
});

test('stable unique-looking candidate is deterministic, canonical and stays inside prefix',()=>{
  assert.equal(candidateDestinationIPv6(prefix,a,key),ip);
  assert.equal(isWithinDelegated64(ip,prefix),true);
  assert.notEqual(candidateDestinationIPv6(prefix,b,key),ip);
  assert.notEqual(candidateDestinationIPv6(prefix,a,key,1),ip);
  assert.equal(isWithinDelegated64('2a03:1234:5678:abce::1',prefix),false);
  assert.equal(isWithinDelegated64('1.2.3.4',prefix),false);
  assert.throws(()=>candidateDestinationIPv6(prefix,a,Buffer.alloc(8)));
  assert.throws(()=>candidateDestinationIPv6(prefix,'not-uuid',key));
  assert.throws(()=>candidateDestinationIPv6(prefix,a,key,-1));
  // Registry / SQL claim, not HMAC randomness, guarantees no address reuse.
});

test('prefix evidence alone never enables checkout',()=>{
  const missing=ipv6PaidLaunchCandidate(null,{
    providerConfirmed:false,publiclyReachable:false,
    ipv4OnlyClientFallbackVerified:false,serverIsExistingForeignVps:true,
  });
  assert.deepEqual(missing.reasons,[
    'NO_DELEGATED_PREFIX','PROVIDER_ROUTING_UNVERIFIED',
    'EXTERNAL_IPV6_REACHABILITY_UNVERIFIED','IPV4_ONLY_CLIENT_UNVERIFIED',
  ]);
  const measured=ipv6PaidLaunchCandidate(prefix,{
    providerConfirmed:true,publiclyReachable:true,
    ipv4OnlyClientFallbackVerified:true,serverIsExistingForeignVps:true,
  });
  assert.equal(measured.candidate,true);
  assert.equal(measured.productionCheckoutEnabled,false);
});

test('admit only exact paid destination and approved original TLS SNI',()=>{
  const res=admit();
  assert.deepEqual(res,{admitted:true,reason:'ADMIT',entitlementId:a,revision:3});
  assert.equal(admit(grant(),ip,'api.anthropic.com').admitted,true);
  assert.equal(admit(null).reason,'NO_TRUSTED_ENTITLEMENT');
  assert.equal(admit(grant(),'2a03:1234:5678:abce::12').reason,'UNKNOWN_DESTINATION');
  assert.equal(admit(grant({destinationIPv6:'2a03:1234:5678:abcd::999'})).reason,'UNKNOWN_DESTINATION');
  assert.equal(admit(grant(),ip,'gemini.google.com').reason,'UNAPPROVED_SNI');
  assert.equal(admit(grant(),ip,'').reason,'INVALID_SNI');
  assert.equal(admit(grant(),ip,'*.claude.ai').reason,'INVALID_SNI');
  assert.equal(admit(grant(),ip,'claude.ai',null).reason,'PREFIX_UNAVAILABLE');
  assert.equal(admit(grant(),ip,'claude.ai','2001:db8::/64').reason,'PREFIX_UNAVAILABLE');
  assert.equal(admit(grant({retiredAt:now})).reason,'INACTIVE');
  assert.equal(admit(grant({state:'REFUNDED'})).reason,'INACTIVE');
  assert.equal(admit(grant({state:'PAID_PENDING_PROVISIONING'})).reason,'INACTIVE');
  assert.equal(admit(grant({expiresAt:now})).reason,'EXPIRED');
  assert.equal(admit(grant({expiresAt:null})).reason,'EXPIRED');
  assert.equal(admit(grant({quotaState:'EXHAUSTED'})).reason,'QUOTA_EXHAUSTED');
  assert.equal(admit(grant({quotaRemainingBytes:0n})).reason,'QUOTA_EXHAUSTED');
  assert.equal(admit(grant({revision:0})).reason,'INVALID_REVISION');
});

test('predebit each block before any bytes are forwarded and respect max size',async()=>{
  const events:Array<{kind:string,bytes:number,event?:string}>=[];
  let remaining=100_000;
  const gate=new MeteredChunkGate(admit(),{
    debit:async (_id,event,n)=>{
      events.push({kind:'debit',bytes:n,event});
      if(n>remaining)return 'DENY_QUOTA';
      remaining-=n;
      return 'ACCEPTED';
    },
  },{
    send:async bytes=>{events.push({kind:'send',bytes:bytes.length});},
  });
  await gate.forward(new Uint8Array(40_000));
  assert.deepEqual(events.map(e=>[e.kind,e.bytes]),[
    ['debit',16384],['send',16384],
    ['debit',16384],['send',16384],
    ['debit',7232],['send',7232],
  ]);
  assert.equal(new Set(events.filter(e=>e.event).map(e=>e.event)).size,3);
  assert.equal(remaining,60_000);
});

test('quota exhaustion stops only after charged packets; no unbilled bytes',async()=>{
  let charged=0,forwarded=0,remaining=20_000;
  const gate=new MeteredChunkGate(admit(),{
    debit:async (_id,_event,n)=>{
      if(n>remaining)return 'DENY_QUOTA';
      remaining-=n;charged+=n;return 'ACCEPTED';
    },
  },{send:async bytes=>{forwarded+=bytes.length;}});
  await assert.rejects(()=>gate.forward(new Uint8Array(30_000)),/connection closed/);
  assert.equal(charged,16384);
  assert.equal(forwarded,16384);
  await assert.rejects(()=>gate.forward(new Uint8Array(1)),/closed/);
  assert.equal(forwarded,16384);
});

test('backend unavailable or refund/revoke prevents further traffic (fail closed)',async()=>{
  let allowDebit=true,forwarded=0;
  const gate=new MeteredChunkGate(admit(),{
    debit:async (_id,_event,n)=>allowDebit?'ACCEPTED':'DENY_INACTIVE',
  },{send:async bytes=>{forwarded+=bytes.length;}});
  await gate.forward(new Uint8Array(50));
  allowDebit=false;
  await assert.rejects(()=>gate.forward(new Uint8Array(50)));
  assert.equal(forwarded,50);
  await assert.rejects(()=>gate.forward(new Uint8Array(100)));
  const broken=new MeteredChunkGate(admit(),{
    debit:async()=>{throw new Error('database timeout');},
  },{send:async()=>{throw new Error('must not forward');}});
  await assert.rejects(()=>broken.forward(new Uint8Array(3)));
});

test('concurrent calls serialize and do not forward out of order',async()=>{
  const labels:number[]=[];
  const g=new MeteredChunkGate(admit(),{
    debit:async (_id,_event,n)=>{
      labels.push(n);
      await new Promise(resolve=>setImmediate(resolve));
      return 'ACCEPTED';
    },
  },{send:async bytes=>{labels.push(-bytes.length);}});
  await Promise.all([g.forward(new Uint8Array(5)),g.forward(new Uint8Array(8))]);
  assert.deepEqual(labels,[5,-5,8,-8]);
});

test('failed delivery closes the connection; no retry of ambiguously charged data',async()=>{
  let billed=0;
  const g=new MeteredChunkGate(admit(),{
    debit:async()=>{billed++;return 'ACCEPTED';},
  },{send:async()=>{throw new Error('peer closed');}});
  await assert.rejects(()=>g.forward(new Uint8Array(10)));
  await assert.rejects(()=>g.forward(new Uint8Array(10)));
  assert.equal(billed,1);
});

test('stop during in-flight debit does not forward even a charged block',async()=>{
  let completeDebit:((result:string)=>void)|null=null;
  let forwarded=0;
  const g=new MeteredChunkGate(admit(),{
    debit:async()=>await new Promise<string>(resolve=>{completeDebit=resolve;}),
  },{send:async()=>{forwarded++;}});
  const pending=g.forward(new Uint8Array(24));
  // Wait for the task queued on the microtask chain.
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(completeDebit);
  g.stop();
  completeDebit!('ACCEPTED');
  await assert.rejects(pending,/connection closed/);
  assert.equal(forwarded,0);
});

test('unadmitted and unknown credentials cannot construct a metered connection',()=>{
  const denied:IngressAdmission={admitted:false,reason:'NO_TRUSTED_ENTITLEMENT'};
  assert.throws(()=>new MeteredChunkGate(denied,{debit:async()=> 'ACCEPTED'},{send:async()=>{}}));
});
