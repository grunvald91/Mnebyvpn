// Prodamus Payform adapter; no network requests or live keys.
// Official spec: https://help.prodamus.ru/payform/integracii/rest-api/instrukcii-dlya-samostoyatelnaya-integracii-servisov
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type Field = string | number | boolean | Field[] | { [key: string]: Field };
export type Fields = Record<string, Field>;
const secretOK = (key: string) => typeof key === 'string' && key.length >= 32;

function normalized(value: Field, depth = 0): unknown {
  if (depth > 12) throw new Error('Too deeply nested');
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid number');
    return String(value);
  }
  if (Array.isArray(value)) return value.map(v => normalized(v, depth + 1));
  if (value === null || typeof value !== 'object') throw new Error('Invalid form field');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe key');
    out[key] = normalized(value[key], depth + 1);
  }
  return out;
}
export function canonicalProdamusJson(fields: Fields): string {
  return JSON.stringify(normalized(fields)).replace(/\//g, '\\/');
}
export function signProdamus(fields: Fields, key: string): string {
  if (!secretOK(key)) throw new Error('Missing Prodamus key');
  return createHmac('sha256', key).update(canonicalProdamusJson(fields)).digest('hex');
}
export function verifyProdamus(fields: Fields, headerSign: string, key: string): boolean {
  if (typeof headerSign !== 'string' || !/^[0-9a-f]{64}$/i.test(headerSign)) return false;
  const expected = Buffer.from(signProdamus(fields, key), 'hex');
  const actual = Buffer.from(headerSign, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export interface ProdamusOrder {
  id: string;
  provider: 'prodamus';
  currency: 'RUB';
  amountMinor: number;
  state: 'PENDING' | 'PAID' | 'REFUNDED' | 'CANCELLED';
}
export interface ProdamusConfig {
  formUrl: string;
  notificationUrl: string;
  successUrl: string;
  returnUrl: string;
  secret: string;
  /** Optional Prodamus-approved integration code. Without it urlNotification
   * must be configured in the merchant dashboard; Prodamus ignores overrides. */
  sys?:string;
}
function httpsUrl(value: string, allowFragment = false): URL {
  const url = new URL(value);
  // Redirect targets may contain a browser-only anchor (#account, #plans).
  // Merchant and notification endpoints must remain fragment-free.
  if (url.protocol !== 'https:' || url.username || url.password ||
      (!allowFragment && url.hash))
    throw new Error('HTTPS URL required');
  return url;
}
function price(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error('Invalid amount');
  return String(Math.floor(minor / 100)) + '.' + String(minor % 100).padStart(2, '0');
}
/** Signed request for Prodamus do=link. Requesting the URL from Payform returns the final short payment link. */
export function buildProdamusLinkRequest(order: ProdamusOrder, title: string, cfg: ProdamusConfig): string {
  if (order.provider !== 'prodamus' || order.state !== 'PENDING' ||
      !/^[0-9a-f-]{36}$/i.test(order.id) || !title.trim()) throw new Error('Invalid Prodamus order');
  const url = httpsUrl(cfg.formUrl);
  httpsUrl(cfg.notificationUrl);
  httpsUrl(cfg.successUrl, true);
  httpsUrl(cfg.returnUrl, true);
  // Prodamus documents that urlNotification works only together with a
  // merchant-approved integration code (sys). Never send an empty sys while
  // claiming per-order notification is enabled.
  if (cfg.sys !== undefined && !/^[A-Za-z0-9_-]{2,64}$/.test(cfg.sys))
    throw new Error('Invalid merchant Prodamus integration code');
  const data: Fields = {
    do: 'link',
    order_id: order.id,
    currency: 'rub',
    payments_limit: '1',
    products: [{ name: title, price: price(order.amountMinor), quantity: '1' }],
    ...(cfg.sys ? {sys:cfg.sys,urlNotification:cfg.notificationUrl} : {}),
    urlSuccess: cfg.successUrl,
    urlReturn: cfg.returnUrl,
  };
  const params = new URLSearchParams();
  function flatten(k: string, val: Field): void {
    if (Array.isArray(val)) return val.forEach((v, i) => flatten(k + '[' + i + ']', v));
    if (typeof val === 'object' && val !== null) {
      for (const [field, v] of Object.entries(val)) flatten(k + '[' + field + ']', v);
      return;
    }
    params.append(k, String(val));
  }
  for (const [k, val] of Object.entries(data)) flatten(k, val);
  params.set('signature', signProdamus(data, cfg.secret));
  url.search = params.toString();
  return url.toString();
}
export type ProdamusResult =
  | { ok: true; capture: {
      provider: 'prodamus'; orderId: string; providerEventId: string;
      providerTransactionId: string; amountMinor: number; currency: 'RUB'; payloadSha256: string;
    }}
  | { ok: false; reason: string };
function minorFromRub(sum: Field | undefined): number | null {
  if (typeof sum !== 'string' || !/^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(sum)) return null;
  const [whole, coins] = sum.split('.');
  const result = Number(whole) * 100 + Number(coins);
  return Number.isSafeInteger(result) ? result : null;
}
/**
 * Must be called ONLY for parsed POST notifications, with the HTTP Sign
 * header. Caller also needs an atomic SQL settle (unique capture and order).
 * Returning from urlSuccess alone is not evidence of payment.
 * PAID/REFUNDED orders may receive the same valid capture again: downstream SQL
 * must match provider+transaction+order+amount+currency and return DUPLICATE.
 */
export function verifyProdamusPayment(
  data: Fields, signHeader: string, order: ProdamusOrder | null, cfg: ProdamusConfig
): ProdamusResult {
  if (!verifyProdamus(data, signHeader, cfg.secret)) return { ok: false, reason: 'INVALID_SIGNATURE' };
  if (data.payment_status !== 'success') return { ok: false, reason: 'NOT_PAID' };
  if (data.payment_init === 'auto') return { ok: false, reason: 'RECURRING_NOT_IMPLEMENTED' };
  const transactionId = data.order_id;
  if (!order || !['PENDING', 'PAID', 'REFUNDED', 'CANCELLED'].includes(order.state) || order.provider !== 'prodamus'
      || order.currency !== 'RUB' || data.currency !== 'rub' || data.order_num !== order.id
      || data.domain !== httpsUrl(cfg.formUrl).hostname
      || typeof transactionId !== 'string' || transactionId.length === 0
      || transactionId.length > 130 || minorFromRub(data.sum) !== order.amountMinor) {
    return { ok: false, reason: 'ORDER_MISMATCH' };
  }
  return { ok: true, capture: {
    provider: 'prodamus', orderId: order.id,
    providerTransactionId: transactionId, providerEventId: 'paid:' + transactionId,
    amountMinor: order.amountMinor, currency: 'RUB',
    payloadSha256: createHash('sha256').update(canonicalProdamusJson(data)).digest('hex'),
  }};
}
