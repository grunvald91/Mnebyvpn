/**
 * YooKassa API v3 adapter for external website RUB checkout.
 * Official docs: https://yookassa.ru/developers/api
 *
 * Security model: YooKassa webhooks do NOT include an HMAC signature header.
 * Never trust raw webhook payloads! Every payment/refund event MUST be verified
 * by querying GET /v3/payments/{id} or GET /v3/refunds/{id} directly against
 * api.yookassa.ru with shopId + secretKey before settling in PostgreSQL.
 */
import { createHash } from 'node:crypto';
import type { VerifiedCapture } from './store.ts';

export interface YookassaOrder {
  id: string;
  provider: 'yookassa';
  currency: 'RUB';
  amountMinor: number;
  state: 'PENDING' | 'PAID' | 'REFUNDED' | 'CANCELLED';
}

export interface YookassaConfig {
  shopId: string;
  secretKey: string;
  returnUrl: string;
  /** Defaults to https://api.yookassa.ru; only override in offline-test. */
  apiOrigin?: string;
  /** 54-FZ VAT code (1 = without VAT, default for NПД / USN without VAT). */
  vatCode?: number;
  /** Optional 54-FZ tax system code (1..6). */
  taxSystemCode?: number;
  /** Include 54-FZ receipt block using verified customer email (default true). */
  sendReceipt?: boolean;
}

export interface YookassaTransport {
  createPayment(idempotencyKey: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  getPayment(paymentId: string): Promise<Record<string, unknown>>;
  getRefund(refundId: string): Promise<Record<string, unknown>>;
}

export const DEFAULT_YOOKASSA_WEBHOOK_CIDRS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11/32',
  '77.75.156.35/32',
  '77.75.154.128/25',
  '2a02:5180::/32',
] as const;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const paymentIdPattern = /^[A-Za-z0-9_-]{10,80}$/;

function assertConfig(cfg: YookassaConfig): { origin: string; authHeader: string; returnUrl: URL } {
  if (!/^\d{4,12}$/.test(cfg.shopId)) throw new Error('Invalid YooKassa shopId');
  if (typeof cfg.secretKey !== 'string' || cfg.secretKey.length < 20) {
    throw new Error('Invalid YooKassa secretKey');
  }
  const returnUrl = new URL(cfg.returnUrl);
  if (returnUrl.protocol !== 'https:' || returnUrl.username || returnUrl.password) {
    throw new Error('HTTPS returnUrl required');
  }
  const originUrl = new URL(cfg.apiOrigin ?? 'https://api.yookassa.ru');
  if (!['https:', 'http:'].includes(originUrl.protocol) || originUrl.username || originUrl.password) {
    throw new Error('Invalid YooKassa API origin');
  }
  if (originUrl.protocol !== 'https:' && originUrl.hostname !== '127.0.0.1') {
    throw new Error('YooKassa API requires HTTPS');
  }
  const authHeader = 'Basic ' + Buffer.from(cfg.shopId + ':' + cfg.secretKey, 'utf8').toString('base64');
  return { origin: originUrl.origin, authHeader, returnUrl };
}

export function minorFromRubString(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(value)) return null;
  const [whole, coins] = value.split('.');
  const minor = Number(whole) * 100 + Number(coins);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function rubStringFromMinor(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error('Invalid RUB amount');
  return String(Math.floor(minor / 100)) + '.' + String(minor % 100).padStart(2, '0');
}

export function approvedYookassaConfirmationHost(hostname: string, allowTestHost?: string): boolean {
  const host = hostname.toLowerCase();
  if (allowTestHost && host === allowTestHost.toLowerCase()) return true;
  return host === 'yookassa.ru' || host.endsWith('.yookassa.ru') ||
    host === 'yoomoney.ru' || host.endsWith('.yoomoney.ru');
}

export function validateYookassaConfirmationUrl(raw: unknown, allowTestHost?: string): string {
  if (typeof raw !== 'string' || raw.length > 2048 || raw.includes('\n') || raw.includes('\r')) {
    throw new Error('Invalid YooKassa confirmation URL');
  }
  const url = new URL(raw.trim());
  const isLocalTest = allowTestHost && url.hostname.toLowerCase() === allowTestHost.toLowerCase();
  if ((url.protocol !== 'https:' && !(isLocalTest && url.protocol === 'http:')) ||
      url.username || url.password || url.hash ||
      !approvedYookassaConfirmationHost(url.hostname, allowTestHost)) {
    throw new Error('Unsafe YooKassa confirmation URL');
  }
  return url.toString();
}

export function buildYookassaPaymentRequest(
  order: YookassaOrder,
  title: string,
  cfg: YookassaConfig,
  customerEmail: string,
): Record<string, unknown> {
  if (order.provider !== 'yookassa' || order.state !== 'PENDING' ||
      !uuidPattern.test(order.id) || !title.trim()) {
    throw new Error('Invalid YooKassa order');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) || customerEmail.length > 254) {
    throw new Error('Invalid verified customer email');
  }
  const { returnUrl } = assertConfig(cfg);
  returnUrl.searchParams.set('payment', 'returned');
  returnUrl.searchParams.set('order', order.id);

  const amountValue = rubStringFromMinor(order.amountMinor);
  const cleanTitle = title.trim().slice(0, 128);
  const vatCode = cfg.vatCode ?? 1;
  if (!Number.isSafeInteger(vatCode) || vatCode < 1 || vatCode > 12) {
    throw new Error('Invalid YooKassa VAT code');
  }
  const body: Record<string, unknown> = {
    amount: { value: amountValue, currency: 'RUB' },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: returnUrl.toString(),
    },
    description: ('MNEBYVPN: ' + cleanTitle).slice(0, 128),
    metadata: { order_id: order.id },
  };
  if (cfg.sendReceipt !== false) {
    const receipt: Record<string, unknown> = {
      customer: { email: customerEmail },
      items: [{
        description: cleanTitle,
        quantity: '1.00',
        amount: { value: amountValue, currency: 'RUB' },
        vat_code: vatCode,
        payment_mode: 'full_payment',
        payment_subject: 'service',
      }],
    };
    if (cfg.taxSystemCode !== undefined) {
      if (!Number.isSafeInteger(cfg.taxSystemCode) || cfg.taxSystemCode < 1 || cfg.taxSystemCode > 6) {
        throw new Error('Invalid YooKassa tax system code');
      }
      receipt.tax_system_code = cfg.taxSystemCode;
    }
    body.receipt = receipt;
  }
  return body;
}

export class HttpYookassaTransport implements YookassaTransport {
  private readonly origin: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  constructor(cfg: YookassaConfig, fetchImpl: typeof fetch = fetch) {
    const parsed = assertConfig(cfg);
    this.origin = parsed.origin;
    this.authHeader = parsed.authHeader;
    this.fetchImpl = fetchImpl;
  }
  private async request(
    method: 'GET' | 'POST',
    path: string,
    idempotencyKey?: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.origin + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'POST' ? 10_000 : 8_000),
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotence-Key': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('PAYMENT_PROVIDER_UNAVAILABLE');
    }
    if (!response.ok) throw new Error('PAYMENT_PROVIDER_UNAVAILABLE');
    const txt = await response.text();
    if (txt.length > 65_536) throw new Error('PAYMENT_PROVIDER_INVALID_LINK');
    let parsed: unknown;
    try { parsed = JSON.parse(txt); } catch { throw new Error('PAYMENT_PROVIDER_INVALID_LINK'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('PAYMENT_PROVIDER_INVALID_LINK');
    }
    return parsed as Record<string, unknown>;
  }
  createPayment(idempotencyKey: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/v3/payments', idempotencyKey, payload);
  }
  getPayment(paymentId: string): Promise<Record<string, unknown>> {
    if (!paymentIdPattern.test(paymentId)) throw new Error('Invalid YooKassa payment id');
    return this.request('GET', '/v3/payments/' + encodeURIComponent(paymentId));
  }
  getRefund(refundId: string): Promise<Record<string, unknown>> {
    if (!paymentIdPattern.test(refundId)) throw new Error('Invalid YooKassa refund id');
    return this.request('GET', '/v3/refunds/' + encodeURIComponent(refundId));
  }
}

export type YookassaWebhookEventName =
  | 'payment.succeeded'
  | 'payment.waiting_for_capture'
  | 'payment.canceled'
  | 'refund.succeeded';

export interface ParsedYookassaNotification {
  event: YookassaWebhookEventName;
  objectId: string;
  metadataOrderId: string | null;
}

export function parseYookassaNotification(raw: unknown): ParsedYookassaNotification | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== 'notification') return null;
  const event = obj.event;
  if (event !== 'payment.succeeded' && event !== 'payment.waiting_for_capture' &&
      event !== 'payment.canceled' && event !== 'refund.succeeded') {
    return null;
  }
  const inner = obj.object;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
  const data = inner as Record<string, unknown>;
  if (typeof data.id !== 'string' || !paymentIdPattern.test(data.id)) return null;
  const meta = data.metadata;
  let metadataOrderId: string | null = null;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const oid = (meta as Record<string, unknown>).order_id;
    if (typeof oid === 'string' && uuidPattern.test(oid)) metadataOrderId = oid;
  }
  return { event, objectId: data.id, metadataOrderId };
}

export type YookassaPaymentVerification =
  | { ok: true; capture: VerifiedCapture }
  | { ok: false; reason: string };

export function verifyYookassaPaymentObject(
  payment: Record<string, unknown>,
  order: YookassaOrder | null,
): YookassaPaymentVerification {
  if (!order || order.provider !== 'yookassa' || order.currency !== 'RUB' ||
      !['PENDING', 'PAID', 'REFUNDED', 'CANCELLED'].includes(order.state)) {
    return { ok: false, reason: 'ORDER_MISMATCH' };
  }
  if (typeof payment.id !== 'string' || !paymentIdPattern.test(payment.id)) {
    return { ok: false, reason: 'INVALID_PAYMENT_ID' };
  }
  if (payment.status !== 'succeeded' || payment.paid !== true) {
    return { ok: false, reason: 'NOT_PAID' };
  }
  const amount = payment.amount as Record<string, unknown> | undefined;
  if (!amount || amount.currency !== 'RUB' || minorFromRubString(amount.value) !== order.amountMinor) {
    return { ok: false, reason: 'ORDER_MISMATCH' };
  }
  const meta = payment.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta.order_id === 'string' && meta.order_id.toLowerCase() !== order.id.toLowerCase()) {
    return { ok: false, reason: 'ORDER_MISMATCH' };
  }
  return {
    ok: true,
    capture: {
      provider: 'yookassa',
      orderId: order.id,
      providerTransactionId: payment.id,
      providerEventId: 'paid:' + payment.id,
      amount: order.amountMinor,
      currency: 'RUB',
      payloadHash: createHash('sha256').update(JSON.stringify(payment)).digest('hex'),
    },
  };
}

export type YookassaRefundVerification =
  | {
      ok: true;
      refund: {
        provider: 'yookassa';
        orderId: string;
        transactionId: string;
        refundEventId: string;
        payloadHash: string;
        amount: number;
        currency: 'RUB';
      };
    }
  | { ok: false; reason: string };

export function verifyYookassaRefundObject(
  refund: Record<string, unknown>,
  order: YookassaOrder | null,
): YookassaRefundVerification {
  if (!order || order.provider !== 'yookassa' || order.currency !== 'RUB') {
    return { ok: false, reason: 'ORDER_MISMATCH' };
  }
  if (typeof refund.id !== 'string' || !paymentIdPattern.test(refund.id) ||
      typeof refund.payment_id !== 'string' || !paymentIdPattern.test(refund.payment_id)) {
    return { ok: false, reason: 'INVALID_REFUND_ID' };
  }
  if (refund.status !== 'succeeded') {
    return { ok: false, reason: 'REFUND_NOT_SUCCEEDED' };
  }
  const amount = refund.amount as Record<string, unknown> | undefined;
  if (!amount || amount.currency !== 'RUB' || minorFromRubString(amount.value) !== order.amountMinor) {
    return { ok: false, reason: 'REFUND_AMOUNT_MISMATCH' };
  }
  return {
    ok: true,
    refund: {
      provider: 'yookassa',
      orderId: order.id,
      transactionId: refund.payment_id,
      refundEventId: 'refund:' + refund.id,
      payloadHash: createHash('sha256').update(JSON.stringify(refund)).digest('hex'),
      amount: order.amountMinor,
      currency: 'RUB',
    },
  };
}

function ipv4ToInt(ip: string): number | null {
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const parts = clean.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = ((value << 8) | n) >>> 0;
  }
  return value;
}

export function isAllowedYookassaWebhookIp(
  ip: string,
  cidrs: readonly string[] = DEFAULT_YOOKASSA_WEBHOOK_CIDRS,
): boolean {
  const addr4 = ipv4ToInt(ip);
  for (const raw of cidrs) {
    const entry = raw.trim();
    if (!entry) continue;
    if (addr4 !== null && !entry.includes(':')) {
      const [base, maskRaw] = entry.split('/');
      const net = ipv4ToInt(base);
      const bits = maskRaw === undefined ? 32 : Number(maskRaw);
      if (net === null || !Number.isSafeInteger(bits) || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((addr4 & mask) === (net & mask)) return true;
    } else if (ip.toLowerCase().startsWith('2a02:5180:') && entry.toLowerCase() === '2a02:5180::/32') {
      return true;
    } else if (ip.toLowerCase() === entry.toLowerCase()) {
      return true;
    }
  }
  return false;
}
