import test from 'node:test';
import assert from 'node:assert/strict';
import {makePersonalDoTIdentity} from '../packages/dns-policy/src/personal-dot-identity.ts';
import {
  parseDnsQuestion,resolvePersonalDnsMessage,
} from '../packages/dns-policy/src/personal-dot-gateway-core.ts';

function query(domain:string,qtype=1):Uint8Array{
  const header=Buffer.alloc(12);
  header.writeUInt16BE(321,0);
  header.writeUInt16BE(0x0100,2); // standard recursive query
  header.writeUInt16BE(1,4);
  const parts=domain.split('.').map(s=>Buffer.concat([Buffer.from([s.length]),Buffer.from(s,'ascii')]));
  return Buffer.concat([header,...parts,Buffer.from([0,0,qtype,0,1])]);
}
const host=makePersonalDoTIdentity(undefined,new Uint8Array(16)).hostname;

test('parse DNS question without following compressed pointers',()=>{
  const a=parseDnsQuestion(query('claude.ai',1));
  assert.deepEqual(a,{name:'claude.ai',type:1,dnsClass:1});
  assert.equal(parseDnsQuestion(query('google.com',65)).type,65);
  const bad=Buffer.from(query('example.org'));
  bad[12]=0xc0;
  assert.throws(()=>parseDnsQuestion(bad));
  const ambiguous=Buffer.from(query('example.org'));
  ambiguous[13]=46; // literal period in a DNS label, not a label separator
  assert.throws(()=>parseDnsQuestion(ambiguous));
  const response=Buffer.from(query('example.org'));
  response[2]=0x81;
  assert.throws(()=>parseDnsQuestion(response));
  assert.throws(()=>parseDnsQuestion(Buffer.alloc(10)));
  const two=Buffer.from(query('example.org'));
  two.writeUInt16BE(2,4);
  assert.throws(()=>parseDnsQuestion(two));
});

test('ordinary websites always use direct resolver and never consume quota',async()=>{
  const calls:string[]=[];
  const out=await resolvePersonalDnsMessage(host,query('example.org'),
    question=>{assert.equal(question.name,'example.org');return 'direct';},
    async()=>{calls.push('charged');return 'ALLOWED';},
    async()=>{calls.push('mapped');return Uint8Array.from([1]);},
    async()=>{calls.push('direct');return Uint8Array.from([2]);});
  assert.deepEqual([...out],[2]);
  assert.deepEqual(calls,['direct']);
});

test('a premium domain consumes one query before the SmartDNS mapped answer',async()=>{
  const calls:string[]=[];
  const out=await resolvePersonalDnsMessage(host,query('claude.ai'),
    ()=> 'premium',
    async label=>{assert.match(label,/^d[a-z2-7]{26}$/);calls.push('debit');return 'ALLOWED';},
    async()=>{calls.push('mapped');return Uint8Array.from([7]);},
    async()=>{calls.push('direct');return Uint8Array.from([4]);});
  assert.deepEqual([...out],[7]);
  assert.deepEqual(calls,['debit','mapped']);
});

test('quota exhaustion or refund preserves ordinary DNS and never uses premium mapping',async()=>{
  for(const outcome of ['DENY_QUOTA','DENY_INACTIVE','DENY_UNKNOWN','DENY_INVALID']){
    const steps:string[]=[];
    const data=await resolvePersonalDnsMessage(host,query('claude.ai'),
      ()=> 'premium',
      async()=>{steps.push('debit');return outcome;},
      async()=>{steps.push('mapped');throw new Error('premium bypass');},
      async()=>{steps.push('direct');return Uint8Array.from([3]);});
    assert.deepEqual([...data],[3]);
    assert.deepEqual(steps,['debit','direct']);
  }
});

test('database outage cannot grant free SmartDNS mapping',async()=>{
  let mappedCalled=false;
  const res=await resolvePersonalDnsMessage(host,query('www.tiktok.com',28),
    ()=> 'premium',
    async()=>{throw new Error('db offline');},
    async()=>{mappedCalled=true;throw new Error('unbilled');},
    async()=>Uint8Array.from([8]));
  assert.equal(mappedCalled,false);
  assert.deepEqual([...res],[8]);
});

test('invalid DoT identity, DNS wire or non-authoritative classification cannot forward',async()=>{
  let calls=0;
  const classify=()=>{calls++;return 'premium' as const;};
  const debit=async()=>{calls++;return 'ALLOWED';};
  const mapped=async()=>{calls++;return Uint8Array.from([1]);};
  const direct=async()=>{calls++;return Uint8Array.from([2]);};
  await assert.rejects(()=>resolvePersonalDnsMessage('dns.mnebyvpn.site',
    query('claude.ai'),classify,debit,mapped,direct));
  await assert.rejects(()=>resolvePersonalDnsMessage(host,
    Uint8Array.from([0,1,2]),classify,debit,mapped,direct));
  assert.equal(calls,0);
  await assert.rejects(()=>resolvePersonalDnsMessage(host,query('claude.ai'),
    ()=>'unknown' as never,debit,mapped,direct));
  assert.equal(calls,0);
});
