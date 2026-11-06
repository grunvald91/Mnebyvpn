import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAdmitNewConnection, debitQuota, desiredEnabled, transition,
  type Entitlement,
} from '../packages/domain/src/entitlement.ts';

const now = new Date('2026-11-05T17:00:00.000Z');
function pending(): Entitlement {
  return {
    id: 'test-subscription', product: 'smart_dns', state: 'PENDING_PAYMENT',
    revision: 0, appliedRevision: 0, expiresAt: null,
    quotaLimitBytes: 100n, quotaUsedBytes: 0n,
  };
}
function active(): Entitlement {
  const paid = transition(pending(), { type: 'verified_payment', verified: true, durationSeconds: 3600 }, now);
  return transition(paid, { type: 'provisioned', expectedRevision: paid.revision }, now);
}

test('no access before verified payment and provisioning', () => {
  const original = pending();
  assert.equal(desiredEnabled(original, now), false);
  assert.equal(canAdmitNewConnection(original, now), false);
  assert.throws(() => transition(original, { type: 'verified_payment', verified: false as true, durationSeconds: 3600 }, now));
  const paid = transition(original, { type: 'verified_payment', verified: true, durationSeconds: 3600 }, now);
  assert.equal(paid.state, 'PAID_PENDING_PROVISIONING');
  assert.equal(canAdmitNewConnection(paid, now), false);
  assert.throws(() => transition(paid, { type: 'verified_payment', verified: true, durationSeconds: 3600 }, now));
  assert.equal(active().state, 'ACTIVE');
});

test('stale provider response cannot acknowledge a post-refund revision', () => {
  const current = active();
  const refunded = transition(current, { type: 'refund' }, now);
  const late = transition(refunded, { type: 'provisioned', expectedRevision: current.revision }, now);
  assert.strictEqual(late, refunded);
  assert.equal(late.state, 'REFUNDED');
  assert.equal(late.appliedRevision, current.appliedRevision);
  assert.equal(canAdmitNewConnection(late, now), false);
});

test('expiry blocks an imported profile regardless of stale provisioning response', () => {
  const item = active();
  const later = new Date(now.getTime() + 3600_000);
  assert.equal(canAdmitNewConnection(item, later), false);
  const expired = transition(item, { type: 'expire' }, later);
  assert.equal(expired.state, 'EXPIRED');
  assert.equal(desiredEnabled(expired, later), false);
  assert.strictEqual(transition(expired, { type: 'provisioned', expectedRevision: item.revision }, later), expired);
});

test('one subscription shares one quota across arbitrary devices', () => {
  let item = active();
  for (const bytes of [30n, 45n, 25n]) {
    const result = debitQuota(item, bytes, now);
    assert.equal(result.accepted, true);
    item = result.value;
  }
  assert.equal(item.quotaUsedBytes, 100n);
  assert.equal(canAdmitNewConnection(item, now), false);
  assert.equal(debitQuota(item, 1n, now).accepted, false);
});

test('no overspend, no invalid or unmetered debit', () => {
  const item = active();
  const overspend = debitQuota(item, 101n, now);
  assert.deepEqual(overspend, { accepted: false, value: item, reason: 'QUOTA_EXCEEDED' });
  assert.equal(debitQuota(item, 0n, now).accepted, false);
  assert.equal(debitQuota({ ...item, quotaLimitBytes: null }, 10n, now).accepted, false);
  assert.equal(debitQuota(transition(item, { type: 'suspend' }, now), 10n, now).accepted, false);
});

test('provisioning failure leaves desired enabled but never gives customer access', () => {
  const paid = transition(pending(), { type: 'verified_payment', verified: true, durationSeconds: 120 }, now);
  const failed = transition(paid, { type: 'provisioning_failed', expectedRevision: paid.revision }, now);
  assert.equal(failed.state, 'PROVISIONING_FAILED');
  assert.equal(desiredEnabled(failed, now), true);
  assert.equal(canAdmitNewConnection(failed, now), false);
});
