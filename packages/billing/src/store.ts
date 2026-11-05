import { randomUUID, createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { PaymentProvider, PricedPlan } from './channels.ts';
import type { StarsOrder } from './stars.ts';
import type { ProdamusOrder } from './prodamus.ts';

export type Product = 'vpn' | 'smart_dns' | 'bundle';
export interface OrderRecord {
  id: string;
  accountId: string;
  provider: PaymentProvider;
  currency: 'RUB' | 'XTR';
  amount: number;
  product: Product;
  planId: string;
  planTitle: string;
  durationSeconds: number;
  dnsQuotaBytes: bigint | null;
  state: 'PENDING' | 'PAID' | 'REFUNDED' | 'CANCELLED';
  expiresAt: Date;
  telegramUserId: number | null;
}
export interface VerifiedCapture {
  provider: PaymentProvider;
  orderId: string;
  providerTransactionId: string;
  providerEventId: string;
  amount: number;
  currency: 'RUB' | 'XTR';
  payloadHash: string;
}
export type SettlementOutcome =
  | 'APPLIED' | 'DUPLICATE_EVENT' | 'DUPLICATE_CAPTURE'
  | 'DENY_INVALID' | 'DENY_UNKNOWN_ORDER' | 'DENY_MISMATCH'
  | 'DENY_EVENT_REUSED' | 'DENY_CAPTURE_REUSED' | 'DENY_ORDER_ALREADY_SETTLED'
  | 'DENY_QUOTA_INVALID';
const safeInt = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Unsafe database integer');
  return n;
};
const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
type Row = Record<string, any>;
function mapOrder(row: Row): OrderRecord {
  const amount = safeInt(row.amount_minor);
  const telegramUserId = row.telegram_user_id === null ? null : safeInt(row.telegram_user_id);
  return {
    id: row.id, accountId: row.account_id, provider: row.provider, currency: row.currency,
    amount, product: row.product, planId: row.plan_id, planTitle: row.plan_title,
    durationSeconds: safeInt(row.duration_seconds),
    dnsQuotaBytes: row.dns_quota_bytes === null ? null : BigInt(row.dns_quota_bytes),
    state: row.state, expiresAt: row.expires_at, telegramUserId,
  };
}
const orderSQL = `
 SELECT o.id, o.account_id, o.provider, o.currency, o.amount_minor,
        o.product, o.state, t.plan_id, t.plan_title, t.duration_seconds,
        t.dns_quota_bytes, t.expires_at, a.telegram_user_id
 FROM orders o JOIN order_terms t ON t.order_id=o.id
 JOIN accounts a ON a.id=o.account_id
 WHERE o.id=$1`;
function mapPlan(row: Row): PricedPlan {
  return {
    planId: row.id, product: row.product, title: row.title,
    durationSeconds: safeInt(row.duration_seconds),
    rubMinor: row.rub_minor === null ? null : safeInt(row.rub_minor),
    stars: row.stars === null ? null : safeInt(row.stars),
    dnsQuotaBytes: row.dns_quota_bytes === null ? null : BigInt(row.dns_quota_bytes),
  };
}
/** Database must have migrations 0001-0004; no paid data plane is touched. */
export class PgBillingStore {
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }
  async plan(planId: string): Promise<PricedPlan | null> {
    const { rows } = await this.pool.query('SELECT * FROM billing_plans WHERE id=$1 AND enabled=true', [planId]);
    return rows.length ? mapPlan(rows[0]) : null;
  }
  async plans(provider: PaymentProvider): Promise<PricedPlan[]> {
    const field = provider === 'telegram_stars' ? 'stars' : 'rub_minor';
    const { rows } = await this.pool.query(
      'SELECT * FROM billing_plans WHERE enabled=true AND '+field+' IS NOT NULL ORDER BY id'
    );
    return rows.map(mapPlan);
  }
  async order(orderId: string): Promise<OrderRecord | null> {
    if (!uuid.test(orderId)) return null;
    const { rows } = await this.pool.query(orderSQL,[orderId]);
    return rows.length ? mapOrder(rows[0]) : null;
  }
  async createTelegramOrder(telegramUserId: number, planId: string, requestId: string): Promise<OrderRecord> {
    if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0)
      throw new Error('Invalid authenticated Telegram user ID');
    return this.createOrder('telegram_stars', { telegramUserId }, planId, requestId);
  }
  /**
   * This method is for an independently authenticated WEBSITE session only.
   * Do not publish a route that accepts arbitrary accountId as proof of login.
   */
  async createWebsiteOrder(accountId: string, planId: string, requestId: string): Promise<OrderRecord> {
    if (!uuid.test(accountId)) throw new Error('Invalid authenticated account');
    return this.createOrder('prodamus', { accountId }, planId, requestId);
  }
  private async createOrder(
    provider: PaymentProvider,
    who: { telegramUserId: number } | { accountId: string },
    planId: string, requestId: string,
  ): Promise<OrderRecord> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(planId)
        || !requestId || requestId.length > 160) throw new Error('Invalid request identity');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // Deterministic key lock serializes concurrent redeliveries across processes.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',[provider,requestId]);
      const existing = await c.query(
        'SELECT order_id FROM checkout_requests WHERE channel=$1 AND request_id=$2',
        [provider, requestId]
      );
      if (existing.rowCount) {
        const r = await c.query(orderSQL,[existing.rows[0].order_id]);
        const order = mapOrder(r.rows[0]);
        if (order.planId !== planId ||
            ('accountId' in who ? order.accountId !== who.accountId : order.telegramUserId !== who.telegramUserId))
          throw new Error('Request key reused for another customer or plan');
        await c.query('COMMIT');
        return order;
      }
      let accountId: string;
      if ('telegramUserId' in who) {
        const account = await c.query(
          `INSERT INTO accounts(id,telegram_user_id) VALUES(gen_random_uuid(),$1)
           ON CONFLICT(telegram_user_id) DO UPDATE
           SET telegram_user_id=EXCLUDED.telegram_user_id RETURNING id`,
          [String(who.telegramUserId)]
        );
        accountId = account.rows[0].id;
      } else {
        const account = await c.query('SELECT id FROM accounts WHERE id=$1',[who.accountId]);
        if (!account.rowCount) throw new Error('Unknown website account');
        accountId = who.accountId;
      }
      const plan = await c.query('SELECT * FROM billing_plans WHERE id=$1 AND enabled=true',[planId]);
      if (!plan.rowCount) throw new Error('Plan not offered');
      const p = plan.rows[0];
      const price = provider === 'telegram_stars' ? p.stars : p.rub_minor;
      if (price === null || safeInt(price) === 0) throw new Error('Price not configured');
      const currency = provider === 'telegram_stars' ? 'XTR' : 'RUB';
      const id = randomUUID();
      await c.query(
        `INSERT INTO orders(id,account_id,product,provider,amount_minor,currency)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [id, accountId, p.product, provider, price, currency]
      );
      await c.query(
        `INSERT INTO order_terms(order_id,plan_id,plan_title,duration_seconds,dns_quota_bytes,expires_at)
         VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')`,
        [id, p.id, p.title, p.duration_seconds, p.dns_quota_bytes]
      );
      await c.query(
        'INSERT INTO checkout_requests(channel,request_id,order_id) VALUES($1,$2,$3)',
        [provider,requestId,id]
      );
      const result = await c.query(orderSQL,[id]);
      await c.query('COMMIT');
      return mapOrder(result.rows[0]);
    } catch(error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }

  /**
   * Only after independently authenticated Telegram update or verified signed
   * Prodamus webhook; SQL atomically writes paid state + outbox signals.
   */
  async settleVerified(capture: VerifiedCapture): Promise<SettlementOutcome> {
    if (!uuid.test(capture.orderId) ||
      !/^[0-9a-f]{64}$/.test(capture.payloadHash) ||
      !Number.isSafeInteger(capture.amount) || capture.amount <= 0) {
      throw new Error('Invalid verified payment capture');
    }
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // Hold lock across reading terms and invoking payment state transition.
      const {rows} = await c.query(orderSQL+' FOR UPDATE OF o',[capture.orderId]);
      if (!rows.length) throw new Error('Order not found');
      const order = mapOrder(rows[0]);
      if (order.provider !== capture.provider || order.amount !== capture.amount ||
          order.currency !== capture.currency) throw new Error('Payment does not match order snapshot');
      const {rows: result} = await c.query(
        `SELECT settle_verified_payment($1,$2,$3,$4,$5,$6,$7,$8,$9) AS outcome`,
        [order.id, capture.provider, capture.providerEventId, capture.providerTransactionId,
         capture.payloadHash, String(order.amount), order.currency,
         String(order.durationSeconds),
         order.dnsQuotaBytes === null ? null : String(order.dnsQuotaBytes)]
      );
      const outcome = result[0].outcome as SettlementOutcome;
      if (!['APPLIED','DUPLICATE_EVENT','DUPLICATE_CAPTURE'].includes(outcome)) {
        throw new Error('Payment settlement denied: '+outcome);
      }
      await c.query('COMMIT');
      return outcome;
    } catch(error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }

  /** No bearer IPv6, VPN credentials, profile URLs or personally sensitive traffic history. */
  async listUserPackages(telegramUserId:number):Promise<Array<{
    product:'vpn'|'smart_dns'; state:string; expiresAt:Date|null;
    quotaLimitBytes:bigint|null; quotaUsedBytes:bigint;
  }>> {
    if(!Number.isSafeInteger(telegramUserId) || telegramUserId<=0) throw new Error('Invalid actor');
    const {rows}=await this.pool.query(
      `SELECT e.product,e.state,e.expires_at,e.quota_limit_bytes,e.quota_used_bytes
        FROM entitlements e JOIN accounts a ON a.id=e.account_id
        WHERE a.telegram_user_id=$1 ORDER BY e.starts_at DESC LIMIT 20`,[String(telegramUserId)]);
    return rows.map(r=>({
      product:r.product,state:r.state,expiresAt:r.expires_at,
      quotaLimitBytes:r.quota_limit_bytes===null?null:BigInt(r.quota_limit_bytes),
      quotaUsedBytes:BigInt(r.quota_used_bytes),
    }));
  }

  /** Apply ONLY independently provider-confirmed full refund, never customer POST. */
  async applyVerifiedRefund(input: {
    provider: PaymentProvider; orderId: string;
    transactionId: string; refundEventId: string; payloadHash: string;
    amount: number; currency: 'RUB' | 'XTR';
  }): Promise<'APPLIED'|'DUPLICATE_EVENT'|'DUPLICATE_REFUND'> {
    if (!uuid.test(input.orderId) || !/^[0-9a-f]{64}$/.test(input.payloadHash) ||
      !input.transactionId || !input.refundEventId || input.transactionId.length>160 ||
      input.refundEventId.length>160) throw new Error('Invalid refund event');
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const {rows}=await c.query(orderSQL+' FOR UPDATE OF o',[input.orderId]);
      if(!rows.length)throw new Error('Refund order absent');
      const o=mapOrder(rows[0]);
      if(o.provider!==input.provider || o.currency!==input.currency || o.amount!==input.amount)
        throw new Error('Refund mismatch');
      const paid=await c.query(
        'SELECT transaction_id FROM provider_captures WHERE provider=$1 AND order_id=$2',
        [input.provider,input.orderId]);
      if(paid.rows[0]?.transaction_id!==input.transactionId)throw new Error('Unknown original charge');
      const result=await c.query('SELECT apply_verified_refund($1,$2,$3,$4,$5) AS result',
        [input.orderId,input.provider,input.refundEventId,input.transactionId,input.payloadHash]);
      const outcome=result.rows[0].result as string;
      if(!['APPLIED','DUPLICATE_EVENT','DUPLICATE_REFUND'].includes(outcome))
        throw new Error('Refund denied: '+outcome);
      await c.query('COMMIT');
      return outcome as 'APPLIED'|'DUPLICATE_EVENT'|'DUPLICATE_REFUND';
    } catch(error) {
      await c.query('ROLLBACK');
      throw error;
    } finally { c.release(); }
  }

  async pendingOutboxForOrder(orderId: string): Promise<number> {
    const {rows} = await this.pool.query(
      `SELECT count(*)::int AS count FROM reconcile_outbox b
       JOIN entitlements e ON e.id=b.entitlement_id
       WHERE e.source_order_id=$1 AND b.handled_at IS NULL`,[orderId]
    );
    return rows[0].count;
  }
}
export function starsOrderFromDB(record: OrderRecord): StarsOrder {
  if (record.provider !== 'telegram_stars' || record.currency !== 'XTR' || !record.telegramUserId)
    throw new Error('Not a Telegram Stars order');
  return {id:record.id,accountId:record.accountId,telegramUserId:record.telegramUserId,
    provider:'telegram_stars',currency:'XTR',amount:record.amount,
    state:record.state,expiresAt:record.expiresAt};
}
export function prodamusOrderFromDB(record: OrderRecord): ProdamusOrder {
  if (record.provider !== 'prodamus' || record.currency !== 'RUB') throw new Error('Not a Prodamus order');
  return {id:record.id,provider:'prodamus',currency:'RUB',
    amountMinor:record.amount,state:record.state};
}
export function starsPaymentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
