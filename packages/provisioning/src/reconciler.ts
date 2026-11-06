/**
 * Offline-tested desired-state reconciler. The database implementation MUST
 * supply an exclusive per-entitlement operation lock and monotonic fencing.
 * A successful DB acknowledgement is not proof that a third-party data plane
 * enforces revocation; that needs separate E2E acceptance tests.
 */
export interface DesiredAccess {
  entitlementId: string;
  revision: number;
  enabled: boolean;
  expiresAt: Date | null;
  /** Unstarted free trial; apply only through an adapter with hard expiry. */
  trialPendingActivation?: boolean;
}

export interface ObservedAccess {
  revision: number;
  enabled: boolean;
}

export interface ReconcileStore {
  /** An exclusive lock covering the complete network operation and verification. */
  withLock<T>(entitlementId: string, fn: (fence: number) => Promise<T>): Promise<T>;
  readDesired(entitlementId: string): Promise<DesiredAccess>;
  /** Compare-and-swap requires matching revision AND current fencing token. */
  acknowledge(entitlementId: string, revision: number, fence: number, observedEnabled: boolean): Promise<boolean>;
  requestReconcile(entitlementId: string, reason: string): Promise<void>;
}

export interface ProvisioningAdapter {
  /** Must enforce expiring access at the data plane, even while panel is offline. */
  enforcesHardExpiry?: true;
  inspect(entitlementId: string): Promise<ObservedAccess>;
  /** Must be idempotent for (entitlementId, revision, enabled). */
  apply(desired: DesiredAccess, operationId: string): Promise<'applied' | 'unknown'>;
}

export type ReconcileResult =
  | { status: 'synced'; revision: number }
  | { status: 'retry_required'; reason: 'unknown_outcome' | 'verification_failed' | 'revision_race' | 'fence_lost' | 'expiry_enforcement_unverified' };

const MAX_CORRECTIONS = 4;

export function effectiveDesired(desired: DesiredAccess, now: Date): DesiredAccess {
  return {
    ...desired,
    enabled: desired.enabled && desired.expiresAt !== null && desired.expiresAt.getTime() > now.getTime(),
  };
}

const matches = (a: ObservedAccess, d: DesiredAccess): boolean =>
  a.enabled === d.enabled && a.revision === d.revision;

/**
 * Outbox is a wake-up signal, not an instruction to replay an old ENABLE.
 * Always inspect latest desired state, including after upstream calls.
 */
export async function reconcileEntitlement(
  entitlementId: string,
  store: ReconcileStore,
  adapter: ProvisioningAdapter,
  now: () => Date = () => new Date(),
): Promise<ReconcileResult> {
  return store.withLock(entitlementId, async fence => {
    for (let round = 0; round < MAX_CORRECTIONS; round++) {
      const desired = effectiveDesired(await store.readDesired(entitlementId), now());
      if(desired.trialPendingActivation && adapter.enforcesHardExpiry!==true){
        await store.requestReconcile(entitlementId,'expiry_enforcement_unverified');
        return {status:'retry_required',reason:'expiry_enforcement_unverified'};
      }
      const before = await adapter.inspect(entitlementId);
      if (!matches(before, desired)) {
        const operationId = [entitlementId, desired.revision, desired.enabled ? 'enable' : 'disable'].join(':');
        // An exception means unknown upstream state: never blindly replay ENABLE.
        let outcome: 'applied' | 'unknown';
        try {
          outcome = await adapter.apply(desired, operationId);
        } catch {
          outcome = 'unknown';
        }
        if (outcome === 'unknown') {
          await store.requestReconcile(entitlementId, 'unknown_outcome');
          return { status: 'retry_required', reason: 'unknown_outcome' };
        }
      }
      const latest = effectiveDesired(await store.readDesired(entitlementId), now());
      if (latest.revision !== desired.revision || latest.enabled !== desired.enabled) {
        // A late ENABLE must be corrected against the newer refund/expiry state.
        continue;
      }
      const observed = await adapter.inspect(entitlementId);
      if (!matches(observed, latest)) {
        await store.requestReconcile(entitlementId, 'verification_failed');
        return { status: 'retry_required', reason: 'verification_failed' };
      }
      if (await store.acknowledge(entitlementId, latest.revision, fence, observed.enabled)) {
        return { status: 'synced', revision: latest.revision };
      }
      await store.requestReconcile(entitlementId, 'fence_lost');
      return { status: 'retry_required', reason: 'fence_lost' };
    }
    await store.requestReconcile(entitlementId, 'revision_race');
    return { status: 'retry_required', reason: 'revision_race' };
  });
}
