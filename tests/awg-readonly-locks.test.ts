import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// The delivery worker needs row-level consistency, but must never require
// UPDATE privileges on billing, release gates or enrollment inventory.
// PostgreSQL FOR SHARE takes a conflicting row lock using SELECT privileges.
const grant=readFileSync(new URL('../packages/provisioning/src/awg-controller-grants.ts',import.meta.url),'utf8');
const outbox=readFileSync(new URL('../packages/provisioning/src/awg-controller-outbox.ts',import.meta.url),'utf8');

test('controller locks billing and inventory rows using SELECT-only FOR SHARE',()=>{
  assert.match(grant,/FROM entitlements ['+]*\s*'WHERE id=\$1 FOR SHARE'/);
  assert.match(grant,/FROM vpn_node_enrollment_inventory ['+]*\s*'WHERE node_id=\$1 FOR SHARE'/);
  assert.match(grant,/vpn_awg_node_pools WHERE node_id=\$1 FOR SHARE/);
  assert.match(outbox,/FROM entitlements ['+]*\s*'WHERE id=\$1 FOR SHARE'/);
  assert.match(outbox,/FROM entitlements WHERE id=\$1 FOR SHARE/);
  assert.match(outbox,/vpn_node_enrollment_inventory ['+]*\s*'WHERE node_id=\$1 FOR SHARE'/);
  assert.match(outbox,/WHERE p.node_id=\$1 FOR SHARE/);
  assert.match(outbox,/WHERE p.node_id=\$1 FOR SHARE'/);
  for(const source of [grant,outbox]){
    assert.doesNotMatch(source,/FROM entitlements\b[\s\S]{0,65}?FOR UPDATE/);
    assert.doesNotMatch(source,/FROM vpn_node_enrollment_inventory\b[\s\S]{0,80}?FOR UPDATE/);
    assert.doesNotMatch(source,/FROM vpn_awg_node_pools\b[\s\S]{0,80}?FOR UPDATE/);
  }
});
test('outbox and peer allocation remain row-write locked for consistent revisions',()=>{
  assert.match(outbox,/FOR UPDATE SKIP LOCKED/);
  assert.match(outbox,/FROM vpn_awg_peer_allocations WHERE node_id=\$1 AND entitlement_id=\$2 FOR UPDATE/);
  assert.match(grant,/FROM vpn_awg_peer_allocations WHERE node_id=\$1 AND entitlement_id=\$2 FOR UPDATE/);
});
