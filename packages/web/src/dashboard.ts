import type { Pool } from 'pg';

type AccessRow = {
  id: string; source_order_id?:string; product: 'vpn'|'smart_dns'; state: string; starts_at: Date|null;
  expires_at: Date|null; quota_limit_bytes: string|null;
  quota_used_bytes: string; quota_state: string;
};

export function publicEntitlement(row: AccessRow, meteringVerified: boolean, now = Date.now()) {
  const expiresAt = row.expires_at?.toISOString() ?? null;
  const secondsRemaining = ['REFUNDED','CANCELLED','EXPIRED'].includes(row.state)
    ? 0 : row.expires_at
      ? Math.max(0, Math.ceil((row.expires_at.getTime() - now) / 1000)) : null;
  const quotaLimitBytes = row.quota_limit_bytes;
  const isDns = row.product === 'smart_dns';
  // The database counter is NOT on-wire metering until signed-off ingress tests.
  const showUsage = isDns && meteringVerified && quotaLimitBytes !== null &&
    row.state === 'ACTIVE' && secondsRemaining !== null && secondsRemaining > 0;
  const limit = showUsage ? BigInt(quotaLimitBytes) : null;
  const used = showUsage ? BigInt(row.quota_used_bytes) : null;
  return {
    id: row.id, sourceOrderId:row.source_order_id??null, product: row.product, state: row.state,
    startsAt: row.starts_at?.toISOString() ?? null, expiresAt, secondsRemaining,
    quotaLimitBytes: isDns ? quotaLimitBytes : null,
    quotaUsedBytes: showUsage ? String(used) : null,
    quotaRemainingBytes: showUsage ? String(limit! > used! ? limit! - used! : 0n) : null,
    quotaExhausted: showUsage && row.quota_state === 'EXHAUSTED',
    meteringVerified: showUsage,
  };
}

export async function loadDashboard(
  pool: Pick<Pool, 'query'>, accountId: string, meteringVerified = false,
  now = Date.now(),
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId)) throw new Error('Invalid verified account');
  const [access, orders] = await Promise.all([
    pool.query(`SELECT e.id,e.source_order_id,e.product,e.state,e.starts_at,e.expires_at,
      e.quota_limit_bytes,e.quota_used_bytes,e.quota_state
      FROM entitlements e
      WHERE e.account_id=$1
      ORDER BY e.expires_at DESC NULLS LAST, e.id DESC LIMIT 40`, [accountId]),
    pool.query(`SELECT o.id,o.product,o.state,o.amount_minor,o.currency,o.created_at,
      t.plan_title FROM orders o
      LEFT JOIN order_terms t ON t.order_id=o.id
      WHERE o.account_id=$1 ORDER BY o.created_at DESC LIMIT 30`,[accountId]),
  ]);
  return {
    identity: { provider: 'account' as const },
    access: (access.rows as AccessRow[]).map(row => publicEntitlement(row, meteringVerified, now)),
    orders: orders.rows.map(row => ({
      id: row.id as string, product: row.product as string, state: row.state as string,
      amountMinor: Number(row.amount_minor), currency: row.currency as string,
      title: row.plan_title as string|null, createdAt: (row.created_at as Date).toISOString(),
    })),
  };
}
