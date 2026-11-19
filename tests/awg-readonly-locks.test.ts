import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// PostgreSQL docs: even SELECT FOR SHARE requires UPDATE on one column.
// The scoped AWG worker must never receive that privilege on billing or
// inventory. Until a reviewed SECURITY DEFINER row-lock gateway exists,
// the production worker fails closed instead of weakening these locks.
const grant=readFileSync(new URL('../packages/provisioning/src/awg-controller-grants.ts',import.meta.url),'utf8');
const outbox=readFileSync(new URL('../packages/provisioning/src/awg-controller-outbox.ts',import.meta.url),'utf8');
const worker=readFileSync(new URL('../apps/service/src/awg-controller-delivery-worker.ts',import.meta.url),'utf8');

test('AWG authorization still has explicit DB row locks and cannot downgrade to plain SELECT',()=>{
  assert.match(grant,/FROM entitlements ['+]*\s*'WHERE id=\$1 FOR SHARE'/);
  assert.match(grant,/FROM vpn_node_enrollment_inventory ['+]*\s*'WHERE node_id=\$1 FOR SHARE'/);
  assert.match(outbox,/FROM entitlements ['+]*\s*'WHERE id=\$1 FOR SHARE'/);
  assert.match(outbox,/FOR UPDATE SKIP LOCKED/);
});

test('worker fail-closes until vetted privileged gateway exists for every read-only relation',()=>{
  for(const func of [
    'public.mnebyvpn_awg_lock_entitlement(uuid)',
    'public.mnebyvpn_awg_lock_node(text)',
    'public.mnebyvpn_awg_lock_node_pool(text)',
  ])assert(worker.includes(func));
  assert(worker.includes("process.env.MNEBYVPN_AWG_ROW_LOCK_GATEWAY!=='reviewed'"));
  assert(worker.includes('AWG signed authorization row-lock gateway is not deployed'));
  assert(worker.includes('if(!checked.rows[0]?.billing_lock'));
});
