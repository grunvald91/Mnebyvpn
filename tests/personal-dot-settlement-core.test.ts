import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePersonalDnsWithSettlement,servfailDnsResponse,
  dnsResponseMatchesQuestion,
} from '../packages/dns-policy/src/personal-dot-gateway-core.ts';

const host='abcdefghijkl.dns.mnebyvpn.site';
function query(name:string):Buffer{
 const h=Buffer.alloc(12);h.writeUInt16BE(51,0);h.writeUInt16BE(0x0100,2);h.writeUInt16BE(1,4);
 return Buffer.concat([h,...name.split('.').map(x=>Buffer.concat([Buffer.from([x.length]),Buffer.from(x)])),
   Buffer.from([0,0,1,0,1])]);
}
function answer(q:Uint8Array):Uint8Array{
 const a=Buffer.from(q);a.writeUInt16BE(0x8180,2);return a;
}
function isServfail(req:Buffer,res:Uint8Array):boolean{
 const b=Buffer.from(res);
 return b.readUInt16BE(0)===req.readUInt16BE(0)
   && b.readUInt16BE(2)===0x8182
   && b.readUInt16BE(4)===1
   && b.readUInt16BE(6)===0
   && b.readUInt16BE(8)===0
   && b.readUInt16BE(10)===0
   && dnsResponseMatchesQuestion(req,res);
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

test('upstream failure and forged response release quota and return SERVFAIL, never direct',async()=>{
 for(const invalid of [false,true]){
  const steps:string[]=[];
  const request=query('claude.ai');
  const response=await resolvePersonalDnsWithSettlement(host,request,
   ()=> 'premium',async()=>{steps.push('reserve');return 'RESERVED';},
   async(_id,ok)=>{steps.push(ok?'settle':'release');return 'RELEASED';},
   async q=>{
     steps.push('mapped');
     if(!invalid)throw Error('mapped TCP timeout');
     return answer(query('wrong.example'));
   },
   async q=>{steps.push('direct');return answer(q);});
  assert.equal(isServfail(request,response),true);
  assert.deepEqual(steps,['reserve','mapped','release']);
 }
});

test('DB outage returns SERVFAIL while genuine quota/inactive denial stays direct',async()=>{
 let mapped=0,direct=0;
 for(const verdict of ['DENY_QUOTA','DENY_INACTIVE']){
  const request=query('claude.ai');
  const res=await resolvePersonalDnsWithSettlement(host,request,
   ()=> 'premium',async()=>verdict,
   async()=>{throw Error('should not finalize');},
   async q=>{mapped++;return answer(q);},
   async q=>{direct++;return answer(q);});
  assert.equal(isServfail(request,res),false);
 }
 const request=query('claude.ai');
 const res=await resolvePersonalDnsWithSettlement(host,request,
  ()=> 'premium',async()=>{throw Error('DB offline');},
  async()=>{throw Error('should not finalize');},
  async q=>{mapped++;return answer(q);},
  async q=>{direct++;return answer(q);});
 assert.equal(isServfail(request,res),true);
 assert.equal(mapped,0);assert.equal(direct,2);
});

test('failed settlement suppresses paid mapping without direct origin leak',async()=>{
 let calls=0;
 const request=query('claude.ai');
 const response=await resolvePersonalDnsWithSettlement(host,request,
  ()=> 'premium',async()=> 'RESERVED',
  async()=> 'RELEASED',
  async()=>{calls++;return answer(query('claude.ai'));},
  async q=>{calls++;return answer(q);});
 assert.equal(calls,1);
 assert.equal(isServfail(request,response),true);
});

test('unknown verdict and classifier errors fail closed for premium routes',async()=>{
 const req=query('claude.ai');
 let direct=0;
 for(const classify of [()=>{throw Error('bad policy');},()=> 'premium' as const]){
   const res=await resolvePersonalDnsWithSettlement(host,req,classify,
      async()=> 'DENY_UNKNOWN',async()=> 'NOPE',
      async q=>answer(q),
      async q=>{direct++;return answer(q);});
   assert.equal(isServfail(req,res),true);
 }
 assert.equal(direct,0);
});

test('ordinary domains remain direct and are not charged on DB outage',async()=>{
 const req=query('example.org');
 let reserved=0;
 const res=await resolvePersonalDnsWithSettlement(host,req,
  ()=> 'direct',
  async()=>{reserved++;throw Error('db down');},
  async()=>{throw Error('should not settle');},
  async()=>{throw Error('premium unexpected');},
  async q=>answer(q));
 assert.equal(isServfail(req,res),false);
 assert.equal(reserved,0);
});

test('SERVFAIL response is well-formed for EDNS and keeps exact DNS question',()=>{
 const req=query('claude.ai');
 const edns=Buffer.from([0,0,41,4,208,0,0,0,0,0,0]);
 const withOpt=Buffer.concat([req,edns]);
 withOpt.writeUInt16BE(1,10);
 const result=servfailDnsResponse(withOpt);
 assert.equal(isServfail(withOpt,result),true);
 assert.equal(result.byteLength,req.byteLength);
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

test('strict trial direct answers including repeated cached answers consume quota',async()=>{
 const request=query('example.org');
 let reserves=0,settles=0,resolves=0;
 const cached=answer(request);
 const run=()=>resolvePersonalDnsWithSettlement(host,request,()=> 'direct',
  async()=>{reserves++;return reserves<=2?'RESERVED':'DENY_QUOTA';},
  async(_id,ok)=>{assert.equal(ok,true);settles++;return 'SETTLED';},
  async()=>{throw Error('mapped unexpected');},
  async()=>{resolves++;return cached;},undefined,true);
 assert.equal(isServfail(request,await run()),false);
 assert.equal(isServfail(request,await run()),false);
 assert.equal(isServfail(request,await run()),true);
 assert.deepEqual([reserves,settles,resolves],[3,2,2]);
});

test('strict trial denies all routes on quota, expiry or DB outage without direct fallback',async()=>{
 const request=query('claude.ai');
 for(const route of ['direct','premium'] as const){
  for(const verdict of ['DENY_QUOTA','DENY_INACTIVE','DB_ERROR']){
   let calls=0;
   const result=await resolvePersonalDnsWithSettlement(host,request,()=>route,
    async()=>{if(verdict==='DB_ERROR')throw Error('DB offline');return verdict;},
    async()=>{throw Error('unexpected settlement');},
    async q=>{calls++;return answer(q);},async q=>{calls++;return answer(q);},
    undefined,true);
   assert.equal(isServfail(request,result),true);
   assert.equal(calls,0);
  }
 }
});
