import type { Pool } from 'pg';

type AccessRow = {
  id: string; product: 'vpn'|'smart_dns'; state: string; starts_at: Date|null;
  expires_at: Date|null; quota_limit_bytes: string|null;
  quota_used_bytes: string; quota_state: string;
};

export function publicEntitlement(row: AccessRow, meteringVerified: boolean, now = Date.now()) {
  const expiresAt = row.expires_at?.toISOString() ?? null;
  const secondsRemaining = row.expires_at
    ? Math.max(0, Math.ceil((row.expires_at.getTime() - now) / 1000)) : null;
  const quotaLimitBytes = row.quota_limit_bytes;
  const isDns = row.product === 'smart_dns';
  // The database counter is NOT on-wire metering until signed-off ingress tests.
  const showUsage = isDns && meteringVerified && quotaLimitBytes !== null;
  const limit = showUsage ? BigInt(quotaLimitBytes) : null;
  const used = showUsage ? BigInt(row.quota_used_bytes) : null;
  return {
    id: row.id, product: row.product, state: row.state,
    startsAt: row.starts_at?.toISOString() ?? null, expiresAt, secondsRemaining,
    quotaLimitBytes: isDns ? quotaLimitBytes : null,
    quotaUsedBytes: showUsage ? String(used) : null,
    quotaRemainingBytes: showUsage ? String(limit! > used! ? limit! - used! : 0n) : null,
    quotaExhausted: showUsage && row.quota_state === 'EXHAUSTED',
    meteringVerified: showUsage,
  };
}

export async function loadDashboard(
  pool: Pick<Pool, 'query'>, telegramId: number, meteringVerified = false,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) throw new Error('Invalid Telegram account');
  const [access, orders] = await Promise.all([
    pool.query(`SELECT e.id,e.product,e.state,e.starts_at,e.expires_at,
      e.quota_limit_bytes,e.quota_used_bytes,e.quota_state
      FROM entitlements e JOIN accounts a ON a.id=e.account_id
      WHERE a.telegram_user_id=$1
      ORDER BY e.expires_at DESC NULLS LAST, e.id DESC LIMIT 40`, [String(telegramId)]),
    pool.query(`SELECT o.id,o.product,o.state,o.amount_minor,o.currency,o.created_at,
      t.plan_title FROM orders o JOIN accounts a ON a.id=o.account_id
      LEFT JOIN order_terms t ON t.order_id=o.id
      WHERE a.telegram_user_id=$1 ORDER BY o.created_at DESC LIMIT 30`,[String(telegramId)]),
  ]);
  return {
    identity: { provider: 'telegram' as const },
    access: (access.rows as AccessRow[]).map(row => publicEntitlement(row, meteringVerified, now)),
    orders: orders.rows.map(row => ({
      id: row.id as string, product: row.product as string, state: row.state as string,
      amountMinor: Number(row.amount_minor), currency: row.currency as string,
      title: row.plan_title as string|null, createdAt: (row.created_at as Date).toISOString(),
    })),
  };
}
