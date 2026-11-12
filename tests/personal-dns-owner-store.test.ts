import test from 'node:test';
import assert from 'node:assert/strict';
import {personalDnsSigningKey,PgPersonalDnsLinks}
  from '../packages/billing/src/personal-dns-store.ts';

const aid='a0a0a0a0-0000-4000-8000-000000000020';
const eid='c0c0c0c0-0000-4000-8000-000000000020';
const signingKey=Buffer.alloc(32,11);

function fakePool(opts:{active?:boolean;rev?:number;issued?:string;wrongOwner?:boolean}={}){
  const statements:string[]=[];
  const client={
    query:async(sql:string)=>{
      statements.push(sql);
      if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return{rows:[]};
      if(sql.includes('FROM entitlements WHERE id=$1 AND account_id=$2')){
        return{rows:opts.wrongOwner?[]:[{
          id:eid,product:'smart_dns',state:opts.active===false?'EXPIRED':'ACTIVE',
          expires_at:new Date('2031-01-01T00:00:00Z'),
        }]};
      }
      if(sql.includes('SELECT credential_revision FROM personal_dns_links')){
        return{rows:opts.rev?[{credential_revision:opts.rev}]:[]};
      }
      if(sql.includes('issue_personal_dns_link')){
        return{rows:[{outcome:opts.issued??'ISSUED'}]};
      }
      if(sql.includes('personal_dns_query_balance')){
        return{rows:[{
          used_queries:'413',paid_query_limit:'1000000',
          remaining_queries:'999587',
          subscription_expires_at:new Date('2031-01-01T00:00:00Z'),
        }]};
      }
      throw new Error('Unexpected DB operation: '+sql);
    },
    release:()=>{statements.push('RELEASE');},
  };
  return{pool:{connect:async()=>client} as never,statements};
}

test('signing key is a real 256-bit secret, not a second commercial enable flag',()=>{
  assert.equal(personalDnsSigningKey({}),null);
  assert.equal(personalDnsSigningKey({MNEBYDNS_PERSONAL_DNS_LINK_KEY_HEX:'a'}),null);
  const key=personalDnsSigningKey({
    MNEBYDNS_PERSONAL_DNS_LINK_KEY_HEX:'b'.repeat(64),
  });
  assert.equal(key?.length,32);
});

test('account owner gets deterministic DoT and DoH credentials plus honest balance',async()=>{
  const {pool,statements}=fakePool();
  const store=new PgPersonalDnsLinks(pool,signingKey);
  const a=await store.issueForAccount(aid,eid);
  const b=await store.issueForAccount(aid,eid);
  assert.deepEqual(a,b);
  assert.match(a.link.dotHostname,/\.dns\.mnebyvpn\.site$/);
  assert.equal(a.quota.used,413);
  assert.equal(a.quota.remaining,999587);
  assert.equal(a.quota.metric,'proxied_dns_queries');
  assert.equal(statements.filter(x=>x==='COMMIT').length,2);
  assert.equal(statements.filter(x=>x==='RELEASE').length,2);
});

test('existing version regenerates matching link, no change to the paid DNS identity',async()=>{
  const {pool}=fakePool({rev:7,issued:'ALREADY_ISSUED'});
  const out=await new PgPersonalDnsLinks(pool,signingKey).issueForAccount(aid,eid);
  assert.equal(out.link.credentialRevision,7);
});

test('foreign account and inactive entitlement never reveal a personal DNS link',async()=>{
  for(const opts of [{wrongOwner:true},{active:false},{issued:'DENY_NO_PAID_CREDIT'}]){
    const {pool,statements}=fakePool(opts);
    await assert.rejects(
      ()=>new PgPersonalDnsLinks(pool,signingKey).issueForAccount(aid,eid),
      /DNS_/,
    );
    assert.equal(statements.includes('ROLLBACK'),true);
    assert.equal(statements.includes('COMMIT'),false);
    assert.equal(statements.at(-1),'RELEASE');
  }
});

test('reject invalid account ID and missing signing key before touching SQL',async()=>{
  const {pool,statements}=fakePool();
  assert.throws(()=>new PgPersonalDnsLinks(pool,Buffer.alloc(4)),/signing key/);
  const store=new PgPersonalDnsLinks(pool,signingKey);
  await assert.rejects(()=>store.issueForAccount('not-a-uuid',eid));
  assert.equal(statements.length,0);
});

test('private link API route demands account session and avoids HTTP caching',async()=>{
  const {readFileSync}=await import('node:fs');
  const server=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
  const authorize=server.indexOf('const auth = await authorized(req)');
  const handle=server.indexOf("url.pathname==='/api/dns-personal'");
  assert.ok(authorize>=0 && handle>authorize);
  assert.match(server,/personalDnsStore\.issueForAccount\(auth\.accountId,entitlementId\)/);
  assert.match(server,/Cache-Control','no-store, private'/);
  assert.match(server,/Referrer-Policy','no-referrer'/);
  assert.match(server,/PERSONAL_DNS_NOT_AVAILABLE/);
  assert.match(server,/DNS_PACKAGE_NOT_AVAILABLE/);
});
