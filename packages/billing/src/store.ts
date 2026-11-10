import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { planWidgetKey } from '../../telegram-ui/src/widget-104.ts';
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
    deviceLimit: row.device_limit === null || row.device_limit === undefined ? 1 : safeInt(row.device_limit),
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
  async createTelegramOrder(telegramUserId: number, planId: string, requestId: string, inviteToken?:string,expectedKey?:string,preferredOrderId?:string): Promise<OrderRecord> {
    if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0)
      throw new Error('Invalid authenticated Telegram user ID');
    return this.createOrder('telegram_stars', { telegramUserId }, planId, requestId, inviteToken,expectedKey,undefined,preferredOrderId);
  }
  /**
   * This method is for an independently authenticated WEBSITE session only.
   * Do not publish a route that accepts arbitrary accountId as proof of login.
   */
  async createWebsiteOrder(accountId: string, planId: string, requestId: string,
    inviteToken?:string, renewalTargetId?:string): Promise<OrderRecord> {
    if (!uuid.test(accountId)) throw new Error('Invalid authenticated account');
    // This MUST be called only by a website backend after its session check.
    // An arbitrary accountId supplied by a browser is NOT authentication.
    return this.createOrder('prodamus', { accountId }, planId, requestId,inviteToken,undefined,renewalTargetId);
  }
  private async createOrder(
    provider: PaymentProvider,
    who: { telegramUserId: number } | { accountId: string },
    planId: string, requestId: string, inviteToken?: string,expectedKey?:string,renewalTargetId?:string,preferredOrderId?:string,
  ): Promise<OrderRecord> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(planId)
        || !requestId || requestId.length > 160) throw new Error('Invalid request identity');
    if (preferredOrderId!==undefined && !uuid.test(preferredOrderId))
      throw new Error('Invalid pre-signed order identity');
    if (expectedKey!==undefined && !/^[A-Za-z0-9_-]{16}$/.test(expectedKey))
      throw new Error('Invalid expected offer key');
    if (inviteToken!==undefined && !/^[A-Za-z0-9_-]{16,24}$/.test(inviteToken))
      throw new Error('Invalid invite token');
    if (renewalTargetId!==undefined && !uuid.test(renewalTargetId))
      throw new Error('Invalid renewal target');
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
        if(expectedKey!==undefined && planWidgetKey(pricedPlanForOrder(order))!==expectedKey)
          throw new Error('OFFER_CHANGED');
        const saved=await c.query('SELECT invite_token FROM order_referrals WHERE order_id=$1',[order.id]);
        if ((saved.rows[0]?.invite_token??undefined)!==inviteToken)
          throw new Error('Request key reused with different referral');
        const renewal=await c.query('SELECT entitlement_id FROM order_renewals WHERE order_id=$1',[order.id]);
        if ((renewal.rows[0]?.entitlement_id??undefined)!==renewalTargetId)
          throw new Error('Request key reused with different renewal target');
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
      // Lock one customer row across the entire checkout, including the
      // pending-order cap, to serialize concurrent callbacks across processes.
      await c.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
      await c.query(`UPDATE orders o SET state='CANCELLED'
        FROM order_terms ot WHERE ot.order_id=o.id
          AND o.account_id=$1 AND o.state='PENDING'
          AND ot.expires_at<=clock_timestamp()`,[accountId]);
      const cap=await c.query(`SELECT count(*)::int AS total FROM orders
        WHERE account_id=$1 AND state='PENDING'
          AND created_at>clock_timestamp()-interval '15 minutes'`,[accountId]);
      if(cap.rows[0].total>=3)throw new Error('PENDING_CHECKOUT_RATE_LIMIT');
      let referralOwner: string | null=null;
      if(inviteToken!==undefined){
        if(provider!=='telegram_stars' && !(provider==='prodamus' && 'accountId' in who))
          throw new Error('Referral requires authenticated checkout');
        const invite=await c.query(
          'SELECT referrer_account_id FROM referral_invites WHERE token=$1 AND plan_id=$2',
          [inviteToken,planId]);
        if(!invite.rowCount)throw new Error('Unknown or mismatched referral');
        referralOwner=invite.rows[0].referrer_account_id;
        if(referralOwner===accountId)throw new Error('Self-referral is not permitted');
      }
      const plan = await c.query('SELECT * FROM billing_plans WHERE id=$1 AND enabled=true FOR SHARE',[planId]);
      if (!plan.rowCount) throw new Error('Plan not offered');
      const p = plan.rows[0];
      if(expectedKey!==undefined && planWidgetKey(mapPlan(p))!==expectedKey)
        throw new Error('OFFER_CHANGED');
      if (renewalTargetId!==undefined) {
        if (provider!=='prodamus' || !('accountId' in who) || p.product==='bundle')
          throw new Error('Unsupported renewal offer');
        // Bind to this authenticated account and matching product. Pending
        // trial reservations without a real activation deadline cannot renew.
        const renewal=await c.query(`SELECT e.id FROM entitlements e
          WHERE e.id=$1 AND e.account_id=$2 AND e.product=$3
            AND e.state IN ('ACTIVE','EXPIRED','SUSPENDED',
                            'PAID_PENDING_PROVISIONING','PROVISIONING_FAILED')
            AND e.starts_at IS NOT NULL AND e.expires_at IS NOT NULL
          FOR UPDATE OF e`,[renewalTargetId,accountId,p.product]);
        if(renewal.rowCount!==1)throw new Error('Renewal target not owned or not active yet');
      }
      const price = provider === 'telegram_stars' ? p.stars : p.rub_minor;
      if (price === null || safeInt(price) === 0) throw new Error('Price not configured');
      const currency = provider === 'telegram_stars' ? 'XTR' : 'RUB';
      const id = preferredOrderId??randomUUID();
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
      if(renewalTargetId!==undefined)
        await c.query('INSERT INTO order_renewals(order_id,entitlement_id) VALUES($1,$2)',
          [id,renewalTargetId]);
      if(referralOwner!==null){
        await c.query(
          'INSERT INTO order_referrals(order_id,invite_token,referrer_account_id) VALUES($1,$2,$3)',
          [id,inviteToken,referralOwner]);
      }
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


  /** Reserve at most one sendInvoice attempt, across concurrent workers.
   * Never retry an ambiguous Telegram HTTP error for the same order.
   */
  async reserveStarsInvoice(orderId:string,telegramUserId:number):Promise<boolean> {
    if(!uuid.test(orderId)||!Number.isSafeInteger(telegramUserId)||telegramUserId<=0)
      throw new Error('Invalid invoice identity');
    const {rows}=await this.pool.query(
      `INSERT INTO telegram_invoice_dispatch(order_id,telegram_user_id)
       SELECT o.id,a.telegram_user_id FROM orders o
       JOIN accounts a ON a.id=o.account_id
       JOIN order_terms t ON t.order_id=o.id
       WHERE o.id=$1 AND o.provider='telegram_stars' AND o.currency='XTR'
         AND o.state='PENDING' AND a.telegram_user_id=$2
         AND t.expires_at>clock_timestamp()
       ON CONFLICT(order_id) DO NOTHING
       RETURNING order_id`,
      [orderId,String(telegramUserId)]);
    return rows.length===1;
  }
  async finishStarsInvoice(orderId:string,status:'SENT'|'UNKNOWN'):Promise<void> {
    if(!uuid.test(orderId)||!['SENT','UNKNOWN'].includes(status))
      throw new Error('Invalid invoice completion');
    const {rowCount}=await this.pool.query(
      `UPDATE telegram_invoice_dispatch SET state=$2,completed_at=clock_timestamp()
       WHERE order_id=$1 AND state='RESERVED'`,[orderId,status]);
    if(rowCount!==1)throw new Error('Invoice dispatch already resolved');
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

  /**
   * Return a VPN entitlement only after a signed Telegram update resolved its
   * owner, the latest revision was acknowledged and the expiry is still live.
   * No subscription bearer URL is ever stored in the billing database.
   */
  async confirmedVpnProfile(telegramUserId:number,entitlementId?:string):Promise<{
    entitlementId:string; expiresAt:Date; revision:number;
  }|null> {
    if(!Number.isSafeInteger(telegramUserId)||telegramUserId<=0)
      throw new Error('Invalid Telegram actor');
    if(entitlementId!==undefined&&!uuid.test(entitlementId))return null;
    const {rows}=await this.pool.query(
      `SELECT e.id,e.expires_at,e.revision
        FROM entitlements e
        JOIN accounts a ON a.id=e.account_id
        JOIN provisioning_state p ON p.entitlement_id=e.id
          AND p.adapter='vpn'
       WHERE a.telegram_user_id=$1 AND ($2::uuid IS NULL OR e.id=$2)
         AND e.product='vpn' AND e.state='ACTIVE'
         AND e.expires_at>clock_timestamp()
         AND p.applied_revision=e.revision AND p.last_observed_at IS NOT NULL
       ORDER BY e.expires_at DESC LIMIT 1`,[String(telegramUserId),entitlementId??null]);
    if(!rows.length)return null;
    return {entitlementId:String(rows[0].id),expiresAt:rows[0].expires_at as Date,
      revision:Number(rows[0].revision)};
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


  /** Public catalog offers, created for this authenticated Telegram account.
   * Only active Stars plans appear in forwarded cards; RUB pricing may also be shown.
   */
  async referralOffers(telegramUserId:number,max=12):Promise<Array<{
    planId:string;title:string;product:Product;stars:number;rubMinor:number|null;
    durationSeconds:number;dnsQuotaBytes:bigint|null;trialAvailable:boolean;token:string;
  }>> {
    if(!Number.isSafeInteger(telegramUserId)||telegramUserId<=0||max<1||max>16)
      throw new Error('Invalid referral owner or page size');
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const {rows:users}=await c.query(
        `INSERT INTO accounts(id,telegram_user_id) VALUES(gen_random_uuid(),$1)
         ON CONFLICT(telegram_user_id) DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id
         RETURNING id`,[String(telegramUserId)]);
      const owner=users[0].id as string;
      const plans=await c.query(
        `SELECT p.*,COALESCE(t.enabled,false) AS trial_available
           FROM billing_plans p
           LEFT JOIN trial_offers t ON t.product=p.product
          WHERE p.enabled=true AND p.stars IS NOT NULL
          ORDER BY
            CASE p.product WHEN 'vpn' THEN 0 WHEN 'smart_dns' THEN 1 ELSE 2 END,
            p.duration_seconds,p.id LIMIT $1`,[max]);
      const offers=[];
      for(const row of plans.rows){
        const token=randomBytes(12).toString('base64url');
        const inserted=await c.query(
          `INSERT INTO referral_invites(token,referrer_account_id,plan_id)
           VALUES($1,$2,$3)
           ON CONFLICT(referrer_account_id,plan_id) DO NOTHING RETURNING token`,
          [token,owner,row.id]);
        const active=inserted.rows[0]?.token ??
          (await c.query('SELECT token FROM referral_invites WHERE referrer_account_id=$1 AND plan_id=$2',
           [owner,row.id])).rows[0]?.token;
        if(!active)throw new Error('Referral invite collision; retry');
        offers.push({planId:row.id as string,title:row.title as string,product:row.product as Product,
          stars:safeInt(row.stars),rubMinor:row.rub_minor===null?null:safeInt(row.rub_minor),
          durationSeconds:safeInt(row.duration_seconds),
          dnsQuotaBytes:row.dns_quota_bytes===null?null:BigInt(row.dns_quota_bytes),
          trialAvailable:row.trial_available===true,
          token:active as string});
      }
      await c.query('COMMIT');
      return offers;
    } catch(error){await c.query('ROLLBACK');throw error;}
    finally{c.release();}
  }

  /** Issue a stable per-plan invite for the verified website account, even
   * when the customer entered via email rather than Telegram. Rewards are not
   * granted here; only attribution occurs when the referred buyer pays.
   */
  async websiteReferralInvite(accountId:string):Promise<{token:string;days:number}|null>{
    if(!uuid.test(accountId))throw new Error('Invalid verified account');
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN');
      const selected=await c.query(
        `SELECT id,duration_seconds FROM billing_plans
          WHERE enabled=true AND product='vpn' AND stars IS NOT NULL AND rub_minor IS NOT NULL
          ORDER BY CASE WHEN duration_seconds=2592000 THEN 0 ELSE 1 END,duration_seconds,id
          LIMIT 1`);
      if(!selected.rowCount){
        await c.query('COMMIT');return null;
      }
      const row=selected.rows[0];
      const token=randomBytes(12).toString('base64url');
      const added=await c.query(
        `INSERT INTO referral_invites(token,referrer_account_id,plan_id)
         VALUES($1,$2,$3)
         ON CONFLICT(referrer_account_id,plan_id) DO NOTHING RETURNING token`,
        [token,accountId,row.id]);
      const active=added.rows[0]?.token ??
        (await c.query(
          'SELECT token FROM referral_invites WHERE referrer_account_id=$1 AND plan_id=$2',
          [accountId,row.id])).rows[0]?.token;
      if(typeof active!=='string'||!/^[A-Za-z0-9_-]{16,24}$/.test(active))
        throw new Error('Referral invite unavailable');
      const seconds=safeInt(row.duration_seconds);
      if(seconds%86400!==0||seconds<=0)throw new Error('Invalid referral term');
      await c.query('COMMIT');
      return {token:active,days:seconds/86400};
    }catch(error){await c.query('ROLLBACK');throw error;}
    finally{c.release();}
  }

  async referralPlan(token:string):Promise<PricedPlan|null> {
    if(!/^[A-Za-z0-9_-]{16,24}$/.test(token))return null;
    const {rows}=await this.pool.query(
      `SELECT p.* FROM referral_invites i JOIN billing_plans p ON p.id=i.plan_id
       WHERE i.token=$1 AND p.enabled=true AND p.stars IS NOT NULL`,[token]);
    return rows.length?mapPlan(rows[0]):null;
  }


  /** Trial is a genuinely free 24h reservation, not a simulated payment.
   * PostgreSQL account row lock + trial_grants PK serialize repeated clicks.
   * No live VPN/DNS activation occurs until a data-plane adapter observes it.
   */
  async grantTrial(telegramUserId:number|string,product:Product,inviteToken?:string,deviceHash?:string):
  Promise<{status:'GRANTED'|'PENDING'|'ALREADY_USED'|'DEVICE_ALREADY_USED'|'UNAVAILABLE';orderId?:string;expiresAt?:Date}> {
    if(!(typeof telegramUserId==='number' && Number.isSafeInteger(telegramUserId) && telegramUserId>0 ||
       typeof telegramUserId==='string' && uuid.test(telegramUserId)) ||
       !['vpn','smart_dns','bundle'].includes(product))throw new Error('Invalid trial request');
    if(deviceHash!==undefined&&!/^[a-f0-9]{64}$/.test(deviceHash))
      throw new Error('Invalid hashed browser trial claim');
    if(inviteToken!==undefined&&!/^[A-Za-z0-9_-]{16,24}$/.test(inviteToken))
      throw new Error('Invalid trial invite');
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const byTelegram=typeof telegramUserId==='number';
      const user=byTelegram
        ?await c.query(
          `INSERT INTO accounts(id,telegram_user_id) VALUES(gen_random_uuid(),$1)
            ON CONFLICT(telegram_user_id) DO UPDATE
            SET telegram_user_id=EXCLUDED.telegram_user_id RETURNING id,telegram_user_id`,
           [String(telegramUserId)])
        :await c.query('SELECT id,telegram_user_id FROM accounts WHERE id=$1',
           [telegramUserId]);
      if(user.rowCount!==1)throw new Error('Unknown authenticated account');
      const accountId=user.rows[0].id as string;
      await c.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
      const earlier=await c.query(
        'SELECT order_id,product,activated_at FROM trial_grants WHERE account_id=$1',
        [accountId]);
      if(earlier.rowCount){
        await c.query('COMMIT');
        return {status:earlier.rows[0].activated_at===null?'PENDING':'ALREADY_USED',
          orderId:earlier.rows[0].order_id};
      }
      const offer=await c.query('SELECT * FROM trial_offers WHERE product=$1 AND enabled=true',
        [product]);
      if(!offer.rowCount){await c.query('COMMIT');return {status:'UNAVAILABLE'};}
      if(inviteToken){
        const referral=await c.query(
          `SELECT i.referrer_account_id FROM referral_invites i
             JOIN billing_plans p ON p.id=i.plan_id
            WHERE i.token=$1 AND p.product=$2 AND p.enabled=true`,
          [inviteToken,product]);
        if(!referral.rowCount || referral.rows[0].referrer_account_id===accountId)
          throw new Error('Invalid or self-owned trial referral');
      }
      if(deviceHash){
        // This is a best-effort cookie-based guard. Database uniqueness
        // serializes concurrent requests from DIFFERENT accounts in one browser.
        const claim=await c.query(
          `INSERT INTO trial_device_claims(device_hash,account_id) VALUES($1,$2)
           ON CONFLICT(device_hash) DO NOTHING RETURNING account_id`,
          [deviceHash,accountId]);
        if(claim.rowCount!==1){
          await c.query('COMMIT');
          return {status:'DEVICE_ALREADY_USED'};
        }
      }
      const id=randomUUID();
      await c.query(
        `INSERT INTO orders(id,account_id,product,provider,amount_minor,currency,state)
         VALUES($1,$2,$3,'internal_trial',0,'XTR','TRIAL')`,
        [id,accountId,product]);
      await c.query(
        `INSERT INTO trial_grants(telegram_user_id,account_id,order_id,product,invite_token)
         VALUES($1,$2,$3,$4,$5)`,
        [user.rows[0].telegram_user_id??null,accountId,id,product,inviteToken??null]);
      const products=product==='bundle'?['vpn','smart_dns']:[product];
      for(const subproduct of products) {
        const entitlementId=randomUUID();
        await c.query(
          `INSERT INTO entitlements(
            id,account_id,source_order_id,product,state,revision,
            starts_at,expires_at,quota_limit_bytes)
           VALUES($1,$2,$3,$4,'PAID_PENDING_PROVISIONING',1,NULL,NULL,$5)`,
           [entitlementId,accountId,id,subproduct,
            subproduct==='smart_dns'?offer.rows[0].dns_quota_bytes:null]);
        await c.query('INSERT INTO reconcile_outbox(entitlement_id,desired_revision) VALUES($1,1)',
          [entitlementId]);
      }
      await c.query('COMMIT');
      return {status:'GRANTED',orderId:id};
    } catch(error){await c.query('ROLLBACK');throw error;}
    finally{c.release();}
  }
  async trialProducts():Promise<Product[]> {
    const {rows}=await this.pool.query(
      'SELECT product FROM trial_offers WHERE enabled=true ORDER BY product');
    return rows.map(r=>r.product as Product);
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
/** Immutable purchase snapshot, never live mutable plan prices at invoice time. */
export function pricedPlanForOrder(record:OrderRecord):PricedPlan {
 return {planId:record.planId,title:record.planTitle,product:record.product,
   stars:record.provider==='telegram_stars'?record.amount:null,
   rubMinor:record.provider==='prodamus'?record.amount:null,
   durationSeconds:record.durationSeconds,dnsQuotaBytes:record.dnsQuotaBytes};
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
