import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const grant=readFileSync(new URL('../packages/provisioning/src/awg-controller-grants.ts',import.meta.url),'utf8');
const outbox=readFileSync(new URL('../packages/provisioning/src/awg-controller-outbox.ts',import.meta.url),'utf8');
const migration=readFileSync(new URL('../db/migrations/0135_awg_worker_row_lock_gateway.sql',import.meta.url),'utf8');

test('trusted worker never attempts privilege-requiring direct billing or inventory locks',()=>{
  assert.match(grant,/FROM public\.awg_worker_lock_entitlement\(\$1::uuid\)/);
  assert.match(grant,/FROM public\.awg_worker_lock_node\(\$1\)/);
  assert.match(grant,/FROM public\.awg_worker_lock_pool\(\$1\)/);
  assert.match(outbox,/FROM public\.awg_worker_lock_entitlement\(\$1::uuid\)/);
  assert.match(outbox,/FROM public\.awg_worker_lock_node\(\$1\)/);
  assert.match(outbox,/FROM public\.awg_worker_lock_pool_node\(\$1\)/);
  for(const source of [grant,outbox]){
    for(const table of ['entitlements','vpn_node_enrollment_inventory','vpn_awg_node_pools']){
      assert.doesNotMatch(source,new RegExp('FROM '+table+'\\b[\\s\\S]{0,100}FOR (UPDATE|SHARE)'));
    }
  }
});

test('bounded definer functions alone acquire row-share locks inside caller transaction',()=>{
  const funcs=[
    'awg_worker_lock_entitlement(uuid)',
    'awg_worker_lock_node(text)',
    'awg_worker_lock_pool(text)',
    'awg_worker_lock_pool_node(text)',
  ];
  for(const signature of funcs){
    assert.ok(migration.includes('FUNCTION public.'+signature));
    assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.'+signature+' FROM PUBLIC;'));
  }
  assert.equal((migration.match(/LANGUAGE sql SECURITY DEFINER/g)||[]).length,4);
  assert.equal((migration.match(/SET search_path = pg_catalog, public/g)||[]).length,4);
  assert.equal((migration.match(/FOR SHARE/g)||[]).length,5); // includes header comment
  assert.match(migration,/FOR SHARE OF p,i/);
  assert.match(migration,/TO mnebyvpn_awg_delivery/);
  assert.match(migration,/p_node='fi-test-01'/);
  assert.doesNotMatch(migration,/GRANT UPDATE/);
  assert.doesNotMatch(migration,/CREATE ROLE/);
  assert.doesNotMatch(migration,/UPDATE (?:public\.)?entitlements/);
  assert.doesNotMatch(migration,/ALTER TABLE .*entitlements/);
});

test('mutable AWG queue and allocations retain explicit row-write locks',()=>{
  assert.match(outbox,/FOR UPDATE SKIP LOCKED/);
  assert.match(outbox,/FROM vpn_awg_peer_allocations WHERE node_id=\$1 AND entitlement_id=\$2 FOR UPDATE/);
  assert.match(grant,/FROM vpn_awg_peer_allocations WHERE node_id=\$1 AND entitlement_id=\$2 FOR UPDATE/);
});
