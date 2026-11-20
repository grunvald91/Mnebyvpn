import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('RU188 subscription backfill only receives four provisioning SELECT columns',()=>{
  const sql=readFileSync('db/migrations/0138_awg_worker_provisioning_read.sql','utf8');
  assert.match(sql,/GRANT SELECT\s*\(entitlement_id,adapter,applied_revision,last_observed_at\)/);
  assert.match(sql,/ON TABLE public\.provisioning_state\s+TO mnebyvpn_awg_delivery/);
  assert.match(sql,/has_column_privilege\(/);
  assert.match(sql,/BEGIN;[\s\S]*COMMIT;/);
  assert.doesNotMatch(sql,/GRANT\s+(?:ALL|INSERT|DELETE|UPDATE)/i);
  assert.doesNotMatch(sql,/GRANT SELECT ON (?:TABLE\s+)?public\.provisioning_state/i);
  assert.doesNotMatch(sql,/\b(?:DROP|TRUNCATE|ALTER TABLE|UPDATE public\.|DELETE FROM)\b/i);
});
