import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveAccessState,formatRemainingTime,formatRemainingQuota}
  from '../packages/telegram-ui/src/access-format.ts';

test('active expiry is calculated from server time, never the client clock',()=>{
 const now=Date.UTC(2026,10,6,12);
 assert.equal(formatRemainingTime(null,now),null);
 assert.equal(formatRemainingTime(new Date(now+30*60_000),now),'Осталось 1 ч');
 assert.equal(formatRemainingTime(new Date(now+24*3600_000),now),'Осталось 1 дн');
 assert.equal(formatRemainingTime(new Date(now+25*3600_000),now),'Осталось 2 дн');
 assert.equal(formatRemainingTime(new Date(now-1),now),'Срок истёк');
 assert.equal(effectiveAccessState('ACTIVE',new Date(now-1),now),'EXPIRED');
 assert.equal(effectiveAccessState('ACTIVE',new Date(now+1),now),'ACTIVE');
 assert.equal(effectiveAccessState('PAID_PENDING_PROVISIONING',new Date(now-1),now),
  'PAID_PENDING_PROVISIONING');
});

test('DNS quota is readable, clamped at zero and safe for BigInt values',()=>{
 const gb=1024n*1024n*1024n;
 assert.equal(formatRemainingQuota(null,10n),null);
 assert.equal(formatRemainingQuota(2n*gb,gb/2n),'Осталось: 1,5 ГБ');
 assert.equal(formatRemainingQuota(gb,2n*gb),'Осталось: 0 Б');
 assert.equal(formatRemainingQuota(1024n,0n),'Осталось: менее 1 МБ');
 assert.equal(formatRemainingQuota(100n,-1n),null);
 assert.equal(formatRemainingQuota(1_000_000_000_000_000n,1n)?.includes('ГБ'),true);
});
