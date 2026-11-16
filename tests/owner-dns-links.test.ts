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
