import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePersonalDnsWithSettlement} from '../packages/dns-policy/src/personal-dot-gateway-core.ts';

const host='abcdefghijkl.dns.mnebyvpn.site';
function query(name:string):Buffer{
 const h=Buffer.alloc(12);h.writeUInt16BE(51,0);h.writeUInt16BE(0x0100,2);h.writeUInt16BE(1,4);
 return Buffer.concat([h,...name.split('.').map(x=>Buffer.concat([Buffer.from([x.length]),Buffer.from(x)])),
   Buffer.from([0,0,1,0,1])]);
}
function answer(q:Uint8Array):Uint8Array{
 const a=Buffer.from(q);a.writeUInt16BE(0x8180,2);return a;
}

test('premium DNS settles only after correctly answered upstream reply',async()=>{
 const steps:string[]=[];
 const response=await resolvePersonalDnsWithSettlement(host,query('claude.ai'),
  ()=> 'premium',async()=>{steps.push('reserve');return 'RESERVED';},
  async(_id,ok)=>{steps.push(ok?'settle':'release');return 'SETTLED';},
  async q=>{steps.push('mapped');return answer(q);},
  async q=>{steps.push('direct');return answer(q);});
 assert.deepEqual(steps,['reserve','mapped','settle']);
 assert.equal(Buffer.from(response).readUInt16BE(0),51);
});

test('upstream failure or forged response releases quota before direct DNS',async()=>{
 for(const invalid of [false,true]){
  const steps:string[]=[];
  const response=await resolvePersonalDnsWithSettlement(host,query('claude.ai'),
   ()=> 'premium',async()=>{steps.push('reserve');return 'RESERVED';},
   async(_id,ok)=>{steps.push(ok?'settle':'release');return 'RELEASED';},
   async q=>{
     steps.push('mapped');
     if(!invalid)throw Error('mapped TCP timeout');
     return answer(query('wrong.example'));
   },
   async q=>{steps.push('direct');return answer(q);});
  assert.equal(Buffer.from(response).readUInt16BE(0),51);
  assert.deepEqual(steps,['reserve','mapped','release','direct']);
 }
});

test('DB failure or revoked quota never returns unpaid premium mapping',async()=>{
 let mapped=0,direct=0;
 for(const verdict of ['DENY_QUOTA','DENY_INACTIVE']){
  await resolvePersonalDnsWithSettlement(host,query('claude.ai'),
   ()=> 'premium',async()=>verdict,
   async()=>{throw Error('should not finalize');},
   async q=>{mapped++;return answer(q);},
   async q=>{direct++;return answer(q);});
 }
 await resolvePersonalDnsWithSettlement(host,query('claude.ai'),
  ()=> 'premium',async()=>{throw Error('DB offline');},
  async()=>{throw Error('should not finalize');},
  async q=>{mapped++;return answer(q);},
  async q=>{direct++;return answer(q);});
 assert.equal(mapped,0);assert.equal(direct,3);
});

test('failed settlement suppresses paid mapping',async()=>{
 let calls=0;
 const response=await resolvePersonalDnsWithSettlement(host,query('claude.ai'),
  ()=> 'premium',async()=> 'RESERVED',
  async()=> 'RELEASED',
  async()=>{calls++;return answer(query('claude.ai'));},
  async q=>{calls++;return answer(q);});
 assert.equal(calls,2);
 assert.equal(Buffer.from(response).readUInt16BE(0),51);
});

test('abort before premium reply releases hold and never returns a mapped answer',async()=>{
 const signal=new AbortController();
 let release=0,direct=0;
 await assert.rejects(resolvePersonalDnsWithSettlement(host,query('claude.ai'),
  ()=> 'premium',async()=> 'RESERVED',
  async(_id,ok)=>{if(!ok)release++;return 'RELEASED';},
  async()=>{signal.abort();throw Error('upstream cancelled');},
  async q=>{direct++;return answer(q);},signal.signal),/aborted/);
 assert.equal(release,1);assert.equal(direct,0);
});
