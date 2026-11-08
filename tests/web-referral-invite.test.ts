import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PgBillingStore} from '../packages/billing/src/store.ts';
import type {Pool} from 'pg';
const accountId='11111111-1111-4111-8111-111111111112';
const web=readFileSync(new URL('../apps/web/src/server.ts',import.meta.url),'utf8');
test('website referral issue is authenticated, CSRF guarded and reports no active rewards',()=>{
  assert.match(web,/url\.pathname==='\/api\/referral-link'/);
  assert.match(web,/csrfAllowed\(req,auth\.raw\)/);
  assert.match(web,/websiteReferralInvite\(auth\.accountId\)/);
  assert.match(web,/rewardsEnabled:false/);
});
test('email customer receives stable token, without creating account or reward',async()=>{
  const queries:Array<{sql:string;args:unknown[]|undefined}>=[];
  const existing='AlreadyIssuedToken';
  const c={
    query:async(sql:string,args?:unknown[])=>{
      queries.push({sql,args});
      if(sql.includes('SELECT id,duration_seconds FROM billing_plans'))return {rowCount:1,rows:[{id:'vpn-30',duration_seconds:2592000}]};
      if(sql.includes('INSERT INTO referral_invites'))return {rowCount:0,rows:[]};
      if(sql.includes('SELECT token FROM referral_invites'))return {rowCount:1,rows:[{token:existing}]};
      return {rowCount:0,rows:[]};
    },
    release:()=>{},
  };
  const store=new PgBillingStore({connect:async()=>c} as unknown as Pool);
  assert.deepEqual(await store.websiteReferralInvite(accountId),{token:existing,days:30});
  assert.ok(queries.some(q=>q.sql.includes('ON CONFLICT(referrer_account_id,plan_id) DO NOTHING')));
  assert.ok(queries.some(q=>q.sql==='COMMIT'));
  assert.ok(!queries.some(q=>q.sql.includes('UPDATE entitlements')));
  assert.ok(queries.find(q=>q.sql.includes('INSERT INTO referral_invites'))?.args?.includes(accountId));
});
test('invite creation rejects untrusted account identifiers',async()=>{
  const store=new PgBillingStore({connect:async()=>{throw Error('must not connect');}} as unknown as Pool);
  await assert.rejects(store.websiteReferralInvite('bad-id'),/Invalid verified account/);
});
test('no published VPN offer does not promise a referral URL',async()=>{
  const c={query:async(sql:string)=>{
    if(sql.startsWith('SELECT id,duration_seconds'))return {rowCount:0,rows:[]};
    return {rowCount:0,rows:[]};
  },release:()=>{}};
  const store=new PgBillingStore({connect:async()=>c} as unknown as Pool);
  assert.equal(await store.websiteReferralInvite(accountId),null);
});
