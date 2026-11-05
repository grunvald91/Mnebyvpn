/**
 * Business-domain rules only. These functions do not prove data-plane enforcement.
 * Production callers must persist a transition and an outbox reconcile signal
 * atomically, then verify enforcement at the appropriate network adapter.
 */
export type Product = 'vpn' | 'smart_dns';
export type EntitlementState =
  | 'PENDING_PAYMENT'
  | 'PAID_PENDING_PROVISIONING'
  | 'PROVISIONING_FAILED'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface Entitlement {
  id: string;
  product: Product;
  state: EntitlementState;
  revision: number;
  appliedRevision: number;
  expiresAt: Date | null;
  quotaLimitBytes: bigint | null;
  quotaUsedBytes: bigint;
}

export type Transition =
  | { type: 'verified_payment'; verified: true; durationSeconds: number }
  | { type: 'provisioned'; expectedRevision: number }
  | { type: 'provisioning_failed'; expectedRevision: number }
  | { type: 'suspend' | 'cancel' | 'refund' | 'expire' };

const activeDesiredStates: ReadonlySet<EntitlementState> = new Set([
  'PAID_PENDING_PROVISIONING', 'PROVISIONING_FAILED', 'ACTIVE',
]);

export function desiredEnabled(item: Entitlement, now: Date): boolean {
  return activeDesiredStates.has(item.state)
    && item.expiresAt !== null
    && item.expiresAt.getTime() > now.getTime()
    && (item.quotaLimitBytes === null || item.quotaUsedBytes < item.quotaLimitBytes);
}

export function canAdmitNewConnection(item: Entitlement, now: Date): boolean {
  return item.state === 'ACTIVE' && desiredEnabled(item, now);
}

/** Prevent stale provisioning completions from acknowledging revoked access. */
export function transition(item: Entitlement, event: Transition, now: Date): Entitlement {
  if (!Number.isFinite(now.getTime())) throw new RangeError('invalid current time');
  if (event.type === 'verified_payment') {
    if (event.verified !== true || item.state !== 'PENDING_PAYMENT') {
      throw new Error('payment cannot activate this entitlement');
    }
    if (!Number.isSafeInteger(event.durationSeconds) || event.durationSeconds <= 0) {
      throw new RangeError('durationSeconds must be a positive safe integer');
    }
    const expiresAtMs = now.getTime() + event.durationSeconds * 1000;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > 8.64e15) throw new RangeError('expiry overflow');
    return { ...item, state: 'PAID_PENDING_PROVISIONING', expiresAt: new Date(expiresAtMs), revision: item.revision + 1 };
  }
  if (event.type === 'provisioned' || event.type === 'provisioning_failed') {
    if (event.expectedRevision !== item.revision || !desiredEnabled(item, now)) return item;
    if (!activeDesiredStates.has(item.state)) return item;
    return {
      ...item,
      state: event.type === 'provisioned' ? 'ACTIVE' : 'PROVISIONING_FAILED',
      appliedRevision: event.type === 'provisioned' ? item.revision : item.appliedRevision,
    };
  }
  if (event.type === 'expire') {
    if (item.expiresAt === null || item.expiresAt.getTime() > now.getTime()) return item;
    if (['EXPIRED', 'REFUNDED', 'CANCELLED'].includes(item.state)) return item;
    return { ...item, state: 'EXPIRED', revision: item.revision + 1 };
  }
  const next: EntitlementState = event.type === 'refund' ? 'REFUNDED'
    : event.type === 'cancel' ? 'CANCELLED' : 'SUSPENDED';
  if (item.state === next || item.state === 'REFUNDED' || item.state === 'CANCELLED') return item;
  return { ...item, state: next, revision: item.revision + 1 };
}

export type UsageResult =
  | { accepted: true; value: Entitlement; exhausted: boolean }
  | { accepted: false; value: Entitlement; reason: 'INACTIVE' | 'INVALID_BYTES' | 'QUOTA_EXCEEDED' | 'UNMETERED' };

/**
 * Pure model for a single atomic charge. Production must use a PostgreSQL row
 * lock/unique usage event, NOT read/modify/write with this function alone.
 */
export function debitQuota(item: Entitlement, bytes: bigint, now: Date): UsageResult {
  if (bytes <= 0n) return { accepted: false, value: item, reason: 'INVALID_BYTES' };
  if (item.quotaLimitBytes === null) return { accepted: false, value: item, reason: 'UNMETERED' };
  if (!canAdmitNewConnection(item, now)) return { accepted: false, value: item, reason: 'INACTIVE' };
  if (item.quotaUsedBytes + bytes > item.quotaLimitBytes) {
    return { accepted: false, value: item, reason: 'QUOTA_EXCEEDED' };
  }
  const used = item.quotaUsedBytes + bytes;
  const exhausted = used === item.quotaLimitBytes;
  return {
    accepted: true,
    exhausted,
    value: { ...item, quotaUsedBytes: used, revision: item.revision + (exhausted ? 1 : 0) },
  };
}
