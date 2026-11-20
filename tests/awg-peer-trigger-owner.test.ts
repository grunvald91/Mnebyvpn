import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('FI native AWG pool trigger keeps owner-only FOR SHARE without growing worker rights',()=>{
  const sql=readFileSync('db/migrations/0139_awg_peer_address_trigger_owner.sql','utf8');
  assert.match(sql,/vpn_awg_enforce_address_pool/);
  assert.match(sql,/vpn_awg_address_immutability/);
  assert.match(sql,/SECURITY DEFINER/);
  assert.match(sql,/SET search_path = pg_catalog, public/);
  assert.match(sql,/actual_owner IS DISTINCT FROM 'mnebyvpn_stage'/);
  assert.match(sql,/REVOKE ALL ON FUNCTION public\.vpn_awg_enforce_address_pool\(\) FROM PUBLIC/);
  assert.doesNotMatch(sql,/GRANT\s+UPDATE|GRANT\s+ALL/i);
  assert.doesNotMatch(sql,/\b(?:DELETE FROM|TRUNCATE|DROP TABLE|UPDATE public\.)\b/i);
});
