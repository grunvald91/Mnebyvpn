import {parsePersonalStarsLinkPayload} from './stars-links.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PricedPlan } from './channels.ts';

/**
 * Provider-neutral trusted order snapshot loaded from the business database.
 * All prices/term/quota are set server-side at order creation.
 */
export interface StarsOrder {
  id: string;
  accountId: string;
  telegramUserId: number;
  provider: 'telegram_stars';
  currency: 'XTR';
  amount: number;
  state: 'PENDING' | 'PAID' | 'REFUNDED' | 'CANCELLED';
  expiresAt: Date;
}
export interface TelegramPreCheckout {
  id: string;
  from: { id: number };
  currency: string;
  total_amount: number;
  invoice_payload: string;
}
export interface TelegramSuccessfulPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id?: string;
  is_recurring?: true;
  subscription_expiration_date?: number;
}
export interface TrustedStarsCapture {
  provider: 'telegram_stars';
  orderId: string;
  providerEventId: string;
  providerTransactionId: string;
  amount: number;
  currency: 'XTR';
  telegramUserId: number;
}
/** Result is only valid when received through authenticated Telegram Bot API update transport. */
export type StarsCaptureResult =
  | { ok: true; capture: TrustedStarsCapture }
  | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = 'mnebyvpn:v1:';

export function starsPayload(orderId: string, secret: string): string {
  if (!UUID.test(orderId) || secret.length < 32) throw new Error('Invalid payload configuration');
  const mac = createHmac('sha256', secret).update(PREFIX + orderId).digest('hex');
  return PREFIX + orderId + ':' + mac;
}
export function parseStarsPayload(payload: string, secret: string): string | null {
  if (typeof payload !== 'string' || secret.length < 32) return null;
  const personal=parsePersonalStarsLinkPayload(payload,secret);
  if(personal)return personal.orderId;
  const match = /^mnebyvpn:v1:([0-9a-f-]{36}):([a-f0-9]{64})$/.exec(payload);
  if (!match || !UUID.test(match[1])) return null;
  const expected = starsPayload(match[1], secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(payload, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b) ? match[1] : null;
}

export interface StarsInvoice {
  chat_id: number;
  title: string;
  description: string;
  payload: string;
  currency: 'XTR';
  prices: Array<{ label: string; amount: number }>;
  start_parameter: string;
}
/** No provider_token for XTR, no subscription_period until recurring policy is built. */
export function buildStarsInvoice(
  order: StarsOrder, plan: PricedPlan, secret: string
): StarsInvoice {
  if (order.provider !== 'telegram_stars' || order.currency !== 'XTR'
      || order.state !== 'PENDING' || !plan.stars || plan.stars !== order.amount
      || !Number.isSafeInteger(order.telegramUserId) || order.telegramUserId <= 0) {
    throw new Error('Invoice/order mismatch');
  }
  // Telegram sendInvoice accepts only 1–32 Unicode characters in title.
  // Catalog entries may be longer; keep the immutable order terms unchanged.
  const invoiceTitle=Array.from(plan.title.trim()).slice(0,32).join('')||'Мне бы VPN';
  return {
    chat_id: order.telegramUserId,
    title: invoiceTitle,
    description: 'Разовый пакет MNEBYVPN. Продление вручную.',
    payload: starsPayload(order.id, secret),
    currency: 'XTR',
    prices: [{ label: invoiceTitle, amount: order.amount }],
    start_parameter: 'order_' + order.id.replaceAll('-', ''),
  };
}
export function validateStarsPreCheckout(
  query: TelegramPreCheckout, order: StarsOrder | null, secret: string, now = new Date()
): { ok: boolean; error_message?: string } {
  const orderId = parseStarsPayload(query.invoice_payload, secret);
  const valid = orderId !== null && order !== null && order.id === orderId
    && order.provider === 'telegram_stars' && order.currency === 'XTR'
    && order.state === 'PENDING' && order.expiresAt.getTime() > now.getTime()
    && query.currency === 'XTR' && Number.isSafeInteger(query.total_amount)
    && query.total_amount > 0 && order.amount === query.total_amount
    && query.from.id === order.telegramUserId;
  return valid ? { ok: true } : { ok: false, error_message: 'Заказ недействителен. Создайте новый.' };
}
/**
 * Call ONLY with payment received via authenticated Telegram update, after
 * checking from.id against the expected order. Never call on a client POST.
 * The SQL capture uniqueness check is the final idempotency boundary.
 */
export function validateStarsSuccess(
  payment: TelegramSuccessfulPayment,
  senderTelegramUserId: number,
  order: StarsOrder | null,
  secret: string,
  _now = new Date()
): StarsCaptureResult {
  const orderId = parseStarsPayload(payment.invoice_payload, secret);
  if (payment.is_recurring || payment.subscription_expiration_date !== undefined) {
    return { ok: false, reason: 'RECURRING_NOT_YET_IMPLEMENTED' };
  }
  // An actual successful_payment may arrive after the pre-checkout deadline.
  // Do not discard a charge solely because the reservation timestamp elapsed.
  if (!orderId || !order || order.id !== orderId || !['PENDING','PAID','REFUNDED','CANCELLED'].includes(order.state)
      || order.currency !== 'XTR'
      || order.provider !== 'telegram_stars' || payment.currency !== 'XTR'
      || !Number.isSafeInteger(payment.total_amount) || payment.total_amount <= 0
      || payment.total_amount !== order.amount || senderTelegramUserId !== order.telegramUserId
      || !payment.telegram_payment_charge_id || payment.telegram_payment_charge_id.length > 160) {
    return { ok: false, reason: 'PAYMENT_ORDER_MISMATCH' };
  }
  return {
    ok: true,
    capture: {
      provider: 'telegram_stars',
      orderId,
      providerEventId: payment.telegram_payment_charge_id,
      providerTransactionId: payment.telegram_payment_charge_id,
      amount: payment.total_amount,
      currency: 'XTR',
      telegramUserId: senderTelegramUserId,
    },
  };
}
