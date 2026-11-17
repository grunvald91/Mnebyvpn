import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {encryptOwnerDnsLabel,decryptOwnerDnsLabel,ownerDnsDuration,ownerDnsLinksAction,ownerDnsExpiryPrompt,ownerDnsExpiryReply} from '../apps/service/src/owner-dns-links.ts';
import {resolveOwnerDnsMessage} from '../packages/dns-policy/src/owner-dns-access.ts';

test('stored bearer is encrypted, authenticated and bound to row and owner',()=>{
  const key=randomBytes(32),id=randomUUID(),owner=123;
  const encrypted=encryptOwnerDnsLabel('abcdefghijkl',id,owner,key);
  assert.ok(!encrypted.includes('abcdefghijkl'));
  assert.equal(decryptOwnerDnsLabel(encrypted,id,owner,key),'abcdefghijkl');
  assert.throws(()=>decryptOwnerDnsLabel(encrypted,randomUUID(),owner,key));
  assert.throws(()=>decryptOwnerDnsLabel(encrypted,id,owner+1,key));
  assert.throws(()=>decryptOwnerDnsLabel(encrypted,id,owner,randomBytes(32)));
});
test('duration and force reply targets are validated without SQL fragments',()=>{
  assert.equal(ownerDnsDuration('12 ч'),43200);
  assert.equal(ownerDnsDuration('7 д'),604800);
  assert.equal(ownerDnsDuration('30'),2592000);
  for(const bad of ['0','-1','1.5','forever','3651 д','1;DROP TABLE owner_dns_links','99999 h'])assert.equal(ownerDnsDuration(bad),null);
  const p=ownerDnsExpiryPrompt('dnslinks:custom:new')!;
  assert.equal(ownerDnsExpiryReply(p.text,'2 ч'),'dnslinks:new:s7200');
  assert.equal(ownerDnsExpiryReply('forged','2 ч'),null);
});
test('outsider and missing owner cannot query or mutate the link database',async()=>{
  let calls=0;
  const db={query:async()=>{calls++;throw Error('must not run')}} as any;
  for(const owner of [null,23]){
    const r=await ownerDnsLinksAction(db,owner,24,randomBytes(32),'dnslinks:permanent','1');
    assert.match(r.text,/Доступ закрыт/);
  }
  assert.equal(calls,0);
});
test('repeated permanent retrieval preserves hostname and inserts no plaintext bearer',async()=>{
  const key=randomBytes(32);let saved:any=null,insertions=0;
  const db={query:async(sql:string,args:any[])=>{
    if(sql.startsWith('INSERT')){
      insertions++;
      assert.match(sql,/ON CONFLICT/);
      assert.equal(args[5],true);assert.equal(args[6],null);
      assert.ok(!JSON.stringify(args).includes('.dns.mnebyvpn.site'));
      saved??={id:args[0],owner_telegram_id:args[1],token_ciphertext:args[3],permanent:true,expires_at:null,revoked_at:null};
      return {rows:[]};
    }
    assert.deepEqual(args,['23','permanent']);return {rows:[saved]};
  }} as any;
  const first=await ownerDnsLinksAction(db,23,23,key,'dnslinks:permanent','1');
  const second=await ownerDnsLinksAction(db,23,23,key,'dnslinks:permanent','2');
  assert.equal(first.text,second.text);assert.equal(insertions,2);
  assert.match(first.text,/Бессрочно/);
});
test('revocation is confirmed and mutations always scope by owner and refuse permanent links',async()=>{
  const sqls:string[]=[];const id=randomUUID();
  const db={query:async(sql:string,args:any[])=>{sqls.push(sql);assert.deepEqual(args,['23',id]);return {rows:[{id}]};}} as any;
  await ownerDnsLinksAction(db,23,23,randomBytes(32),'dnslinks:revoke:'+id,'3');
  assert.equal(sqls.length,0);
  const r=await ownerDnsLinksAction(db,23,23,randomBytes(32),'dnslinks:yes-revoke:'+id,'4');
  assert.match(r.text,/отозвана/);assert.match(sqls[0],/owner_telegram_id=\$1.*NOT permanent/);
});
const question=Buffer.from('002a01000001000000000000076578616d706c65036f72670000010001','hex');
const answer=Buffer.from(question);answer.writeUInt16BE(0x8180,2);
test('expired/revoked/unknown and DB failure never reach either DNS upstream',async()=>{
  for(const status of ['DENY_INACTIVE','UNKNOWN','DENY_UNKNOWN','throw']){
    let queries=0;
    const upstream=async()=>{queries++;return answer;};
    const r=await resolveOwnerDnsMessage('abcdefghijkl',question,async()=>{if(status==='throw')throw Error('offline');return status},()=> 'premium',upstream,upstream);
    assert.equal(Buffer.from(r).readUInt16BE(2)&15,2);assert.equal(queries,0);
  }
});
test('expiry during an upstream request is enforced before returning its mapping',async()=>{
  let allowed=true;
  const r=await resolveOwnerDnsMessage('abcdefghijkl',question,async()=>allowed?'ALLOWED':'DENY_INACTIVE',()=> 'premium',async()=>{allowed=false;return answer},async()=>answer);
  assert.equal(Buffer.from(r).readUInt16BE(2)&15,2);
});
test('owner uses mapped premium and direct ordinary routes without consuming customer quota',async()=>{
  for(const route of ['premium','direct'] as const){
    let mapped=0,direct=0;
    const r=await resolveOwnerDnsMessage('abcdefghijkl',question,async()=> 'ALLOWED',()=>route,async()=>{mapped++;return answer},async()=>{direct++;return answer});
    assert.deepEqual(r,answer);assert.equal(mapped,route==='premium'?1:0);assert.equal(direct,route==='direct'?1:0);
  }
});
function videoQuestion(rrType:number):Buffer{
  const header=Buffer.alloc(12);header.writeUInt16BE(42);header.writeUInt16BE(256,2);header.writeUInt16BE(1,4);
  const domain='rr1---sn-gxuo03g-ig3s.googlevideo.com';
  const tail=Buffer.alloc(5);tail.writeUInt16BE(rrType,1);tail.writeUInt16BE(1,3);
  return Buffer.concat([header,...domain.split('.').map(x=>Buffer.concat([Buffer.from([x.length]),Buffer.from(x)])),tail]);
}
test('owner video A keeps real CDN addresses even when Smart DNS classifies it as premium',async()=>{
  let direct=0,mapped=0;
  const q=videoQuestion(1),a=Buffer.from(q);a.writeUInt16BE(0x8180,2);
  const r=await resolveOwnerDnsMessage('abcdefghijkl',q,async()=> 'ALLOWED',()=> 'premium',async()=>{mapped++;return a},async()=>{direct++;return a});
  assert.deepEqual(r,a);assert.equal(direct,1);assert.equal(mapped,0);
});
test('owner video IPv6 and HTTPS/SVCB hints are NODATA for the deployed IPv4 VPN',async()=>{
  for(const type of [28,64,65]){
    let upstream=0,checks=0;const q=videoQuestion(type);
    const r=Buffer.from(await resolveOwnerDnsMessage('abcdefghijkl',q,async()=>{checks++;return 'ALLOWED'},()=> 'premium',async()=>{upstream++;return answer},async()=>{upstream++;return answer}));
    assert.equal(r.readUInt16BE(2)&15,0);assert.equal(r.readUInt16BE(6),0);assert.equal(r.readUInt16BE(4),1);
    assert.equal(upstream,0);assert.equal(checks,2);
  }
});


test('owner Smart DNS video A uses mapped CDN, legacy VPN link still resolves origin',async()=>{
  const q=videoQuestion(1),a=Buffer.from(q);a.writeUInt16BE(0x8180,2);
  for(const [decision,expected] of [
    ['ALLOWED','direct'],['ALLOWED_SMART_DNS','mapped'],
  ] as const){
    let mapped=0,direct=0,checks=0;
    const r=await resolveOwnerDnsMessage('abcdefghijkl',q,
      async()=>{checks++;return decision},()=> 'direct',
      async()=>{mapped++;return a},async()=>{direct++;return a});
    assert.deepEqual(r,a);
    assert.equal(mapped,expected==='mapped'?1:0);
    assert.equal(direct,expected==='direct'?1:0);
    assert.equal(checks,2);
  }
});

test('Smart DNS owner still uses direct resolver for ordinary domains and suppresses untrusted video hints',async()=>{
  let mapped=0,direct=0;
  const r=await resolveOwnerDnsMessage('abcdefghijkl',question,
    async()=> 'ALLOWED_SMART_DNS',()=> 'direct',
    async()=>{mapped++;return answer},async()=>{direct++;return answer});
  assert.deepEqual(r,answer);
  assert.equal(direct,1);assert.equal(mapped,0);
  for(const rr of [28,64,65]){
    let upstream=0;
    const result=Buffer.from(await resolveOwnerDnsMessage('abcdefghijkl',videoQuestion(rr),
      async()=> 'ALLOWED_SMART_DNS',()=> 'premium',
      async()=>{upstream++;return answer},async()=>{upstream++;return answer}));
    assert.equal(result.readUInt16BE(2)&15,0);
    assert.equal(result.readUInt16BE(6),0);
    assert.equal(upstream,0);
  }
});

test('owner link policy change during DNS resolution fails closed',async()=>{
  const q=videoQuestion(1),a=Buffer.from(q);a.writeUInt16BE(0x8180,2);
  let mode='ALLOWED_SMART_DNS';
  const r=Buffer.from(await resolveOwnerDnsMessage('abcdefghijkl',q,
    async()=>mode,()=> 'premium',async()=>{mode='ALLOWED';return a},async()=>a));
  assert.equal(r.readUInt16BE(2)&15,2);
});

test('owner Smart DNS permanent creation preserves old VPN link, route and idempotency',async()=>{
  const key=randomBytes(32),records=new Map<string,any>(),operations:any[]=[];
  const db={query:async(sql:string,args:any[])=>{
    operations.push({sql,args});
    if(sql.startsWith('INSERT INTO owner_dns_links')){
      const [id,owner,tokenSha,encrypted,requestKey,permanent,seconds,route]=args;
      assert.equal(owner,'23');
      assert.equal(permanent,true);
      assert.equal(seconds,null);
      assert.ok(route==='vpn_origin'||route==='smart_dns');
      if(!records.has(requestKey)){
        records.set(requestKey,{id,owner_telegram_id:owner,token_ciphertext:encrypted,
          video_route:route,permanent,expires_at:null,revoked_at:null});
      }
      return {rows:[]};
    }
    return {rows:[records.get(args[1])].filter(Boolean)};
  }} as any;
  const smart=await ownerDnsLinksAction(db,23,23,key,'dnslinks:smartdns:permanent','a');
  const again=await ownerDnsLinksAction(db,23,23,key,'dnslinks:smartdns:permanent','b');
  const vpn=await ownerDnsLinksAction(db,23,23,key,'dnslinks:permanent','c');
  assert.equal(smart.text,again.text);
  assert.notEqual(smart.text,vpn.text);
  assert.equal(records.size,2);
  assert.equal(records.get('permanent').video_route,'vpn_origin');
  assert.equal(records.get('smartdns:permanent').video_route,'smart_dns');
  assert.match(smart.text,/Smart DNS без VPN/);
  assert.match(vpn.text,/для VPN/);
  assert.ok(!operations.some(x=>JSON.stringify(x.args).includes('.dns.mnebyvpn.site')));
});

test('Smart DNS temporary action and custom duration stay separated from VPN action',async()=>{
  const prompt=ownerDnsExpiryPrompt('dnslinks:custom:smartdns-new');
  assert.ok(prompt);
  assert.equal(ownerDnsExpiryReply(prompt!.text,'2 ч'),'dnslinks:smartdns:new:s7200');
  assert.equal(ownerDnsExpiryReply(ownerDnsExpiryPrompt('dnslinks:custom:new')!.text,'2 ч'),'dnslinks:new:s7200');
  const key=randomBytes(32),rows:any[]=[];
  const db={query:async(sql:string,args:any[])=>{
    if(sql.startsWith('INSERT INTO owner_dns_links')){
      assert.equal(args[5],false);assert.equal(args[6],7200);assert.equal(args[7],'smart_dns');
      rows.push({id:args[0],owner_telegram_id:args[1],token_ciphertext:args[3],
        video_route:args[7],permanent:false,expires_at:new Date(Date.now()+7200000),revoked_at:null});
      return {rows:[]};
    }
    return {rows};
  }} as any;
  const r=await ownerDnsLinksAction(db,23,23,key,'dnslinks:smartdns:new:s7200','unique');
  assert.match(r.text,/Smart DNS без VPN/);
});
