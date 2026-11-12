import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {makePersonalDoTIdentity} from '../../packages/dns-policy/src/personal-dot-identity.ts';

const db=new Pool({host:process.env.PGHOST??'localhost',port:Number(process.env.PGPORT??5432),
 user:process.env.PGUSER??'test',password:process.env.PGPASSWORD??'test',
 database:process.env.PGDATABASE??'mnebyvpn_test',max:20});
const account=randomUUID(),order=randomUUID(),entitlement=randomUUID();
const token=makePersonalDoTIdentity(undefined,new Uint8Array(16).fill(76));

async function rpc(sql:string,args:unknown[]):Promise<string>{
 const {rows}=await db.query(sql,args);
 return String(rows[0]?.verdict??rows[0]?.status??'');
}
async function reserve(label:string,id:string):Promise<string>{
 return rpc('SELECT reserve_personal_dns_query($1,$2::uuid) AS verdict',[label,id]);
}
async function finish(id:string,ok:boolean):Promise<string>{
 return rpc('SELECT finish_personal_dns_query($1::uuid,$2) AS verdict',[id,ok]);
}
before(async()=>{
 await db.query('INSERT INTO accounts(id) VALUES($1)',[account]);
 await db.query(`INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
  VALUES($1,$2,'smart_dns','fixture',20000,'RUB','PAID')`,[order,account]);
 await db.query(`INSERT INTO entitlements
  (id,account_id,source_order_id,product,state,revision,starts_at,expires_at,quota_limit_bytes)
  VALUES($1,$2,$3,'smart_dns','ACTIVE',1,clock_timestamp()-interval '5 minutes',
  clock_timestamp()+interval '30 days',10000000)`,[entitlement,account,order]);
 assert.equal(await rpc(
  'SELECT issue_personal_dns_credential($1,$2,$3,$4) AS status',
  [entitlement,token.label,token.tokenSha256,3]),'ISSUED');
});
after(async()=>db.end());

test('failed upstream answer releases a reserved slot without charging',async()=>{
 const id=randomUUID();
 assert.equal(await reserve(token.label,id),'RESERVED');
 const state=await db.query('SELECT * FROM personal_dns_query_status($1)',[entitlement]);
 assert.equal(BigInt(state.rows[0].used_queries),0n);
 assert.equal(BigInt(state.rows[0].remaining_queries),2n);
 assert.equal(await finish(id,false),'RELEASED');
 assert.equal(await finish(id,false),'DENY_UNKNOWN');
 const updated=await db.query('SELECT * FROM personal_dns_query_status($1)',[entitlement]);
 assert.equal(BigInt(updated.rows[0].used_queries),0n);
 assert.equal(BigInt(updated.rows[0].remaining_queries),3n);
});

test('settled requests increment once, reservations block overspending under concurrency',async()=>{
 const id=randomUUID();
 assert.equal(await reserve(token.label,id),'RESERVED');
 assert.equal(await finish(id,true),'SETTLED');
 assert.equal(await finish(id,true),'DENY_UNKNOWN');
 const ids=Array.from({length:12},()=>randomUUID());
 const results=await Promise.all(ids.map(id=>reserve(token.label,id)));
 assert.equal(results.filter(x=>x==='RESERVED').length,2);
 assert.equal(results.filter(x=>x==='DENY_QUOTA').length,10);
 const settled=ids.filter((_,i)=>results[i]==='RESERVED');
 assert.equal(await finish(settled[0],true),'SETTLED');
 assert.equal(await finish(settled[1],false),'RELEASED');
 const row=await db.query('SELECT * FROM personal_dns_query_status($1)',[entitlement]);
 assert.equal(BigInt(row.rows[0].used_queries),2n);
 assert.equal(BigInt(row.rows[0].remaining_queries),1n);
});

test('abandoned reservations expire and recover, then rotation refuses stale settle',async()=>{
 const expired=randomUUID(),retry=randomUUID();
 assert.equal(await reserve(token.label,expired),'RESERVED');
 await db.query("UPDATE personal_dns_query_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1",[expired]);
 assert.equal(await reserve(token.label,retry),'RESERVED');
 assert.equal(await finish(expired,true),'DENY_UNKNOWN');
 const rotated=makePersonalDoTIdentity(undefined,new Uint8Array(16).fill(81));
 const outcome=await rpc(
  'SELECT rotate_personal_dns_credential($1,$2,$3,$4,$5) AS status',
  [account,entitlement,1,rotated.label,rotated.tokenSha256]);
 assert.equal(outcome,'ROTATED');
 assert.equal(await finish(retry,true),'RELEASED');
 assert.equal(await reserve(token.label,randomUUID()),'DENY_UNKNOWN');
 const count=await db.query('SELECT * FROM personal_dns_query_status($1)',[entitlement]);
 assert.equal(BigInt(count.rows[0].used_queries),2n);
 assert.equal(BigInt(count.rows[0].remaining_queries),1n);
});

test('refunded entitlements cannot reserve paid DNS queries',async()=>{
 const next=makePersonalDoTIdentity(undefined,new Uint8Array(16).fill(81));
 await db.query("UPDATE entitlements SET state='REFUNDED' WHERE id=$1",[entitlement]);
 assert.equal(await reserve(next.label,randomUUID()),'DENY_INACTIVE');
 const {rows}=await db.query('SELECT recognize_personal_dns_credential($1) AS known',[next.label]);
 assert.equal(rows[0].known,false);
});
