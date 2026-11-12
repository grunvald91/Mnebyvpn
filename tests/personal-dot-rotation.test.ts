import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {rotatePersonalDotHostname,personalDotStatusForOwner}
  from '../packages/dns-policy/src/personal-dot-rotation.ts';

const owner='11111111-1111-4111-8111-111111111111';
const another='22222222-2222-4222-8222-222222222222';
const entitlement='33333333-3333-4333-8333-333333333333';

test('only the trusted account is sent to the atomic owner-scoped SQL procedure',async()=>{
  let calls=0;
  const db={query:async(sql:string,params:unknown[])=>{
    calls++;
    assert.match(sql,/rotate_personal_dns_credential\(\$1,\$2,\$3,\$4,\$5\)/);
    assert.equal(params[0],owner);
    assert.equal(params[1],entitlement);
    assert.equal(params[2],3);
    assert.match(params[3] as string,/^[a-z0-9]{12}$/);
    assert.match(params[4] as string,/^[0-9a-f]{64}$/);
    return{rows:[{status:'ROTATED'}]};
  }} as unknown as Pick<Pool,'query'>;
  const r=await rotatePersonalDotHostname(db,owner,entitlement,3);
  assert.equal(r.status,'ROTATED');
  assert.match(r.hostname||'',/^[a-z0-9]{12}\.dns\.mnebyvpn\.site$/);
  assert.equal(r.revision,4);
  assert.equal(calls,1);
});
test('rejects invalid input; never reveals secret on stale/failed rotation',async()=>{
  let calls=0;
  const db={query:async()=>{calls++;return{rows:[{status:'DENY_STALE'}]};}}
    as unknown as Pick<Pool,'query'>;
  assert.deepEqual(await rotatePersonalDotHostname(db,'invalid',entitlement,1),{status:'DENY_INVALID'});
  assert.deepEqual(await rotatePersonalDotHostname(db,owner,entitlement,0),{status:'DENY_INVALID'});
  const out=await rotatePersonalDotHostname(db,owner,entitlement,1);
  assert.deepEqual(out,{status:'DENY_STALE'});
  assert.equal(calls,1);
});
test('status query constrains entitlement to verified owner',async()=>{
  const db={query:async(sql:string,params:unknown[])=>{
    assert.match(sql,/e\.account_id=\$2/);
    assert.deepEqual(params,[entitlement,another]);
    return{rows:[]};
  }} as unknown as Pick<Pool,'query'>;
  assert.equal(await personalDotStatusForOwner(db,another,entitlement),null);
});
