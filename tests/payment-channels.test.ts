import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPaymentChannel, validatePricedPlan } from '../packages/billing/src/channels.ts';
import {
  buildStarsInvoice, parseStarsPayload, starsPayload, validateStarsPreCheckout, validateStarsSuccess,
  type StarsOrder,
} from '../packages/billing/src/stars.ts';
import {
  buildProdamusLinkRequest, canonicalProdamusJson, signProdamus,
  verifyProdamus, verifyProdamusPayment, type Fields, type ProdamusConfig,
  type ProdamusOrder,
} from '../packages/billing/src/prodamus.ts';

const key = 'a'.repeat(48);
const orderId = '11111111-1111-4111-8111-111111111111';
const time = new Date('2026-11-05T20:00:00Z');
const plan = {
  planId: 'vpn-month', product: 'vpn' as const, title: 'VPN на месяц',
  rubMinor: 19900, stars: 250, durationSeconds: 2592000, dnsQuotaBytes: null,
};
const starsOrder: StarsOrder = {
  id: orderId, provider: 'telegram_stars', currency: 'XTR', telegramUserId: 100001,
  accountId: 'test-account', amount: 250, state: 'PENDING',
  expiresAt: new Date(time.getTime() + 3600000),
};
const config: ProdamusConfig = {
  formUrl: 'https://merchant.payform.ru/',
  notificationUrl: 'https://shop.example/notifications',
  successUrl: 'https://shop.example/success',
  returnUrl: 'https://shop.example/return',
  secret: key,
};
const rubOrder: ProdamusOrder = {
  id: orderId, provider: 'prodamus', currency: 'RUB', amountMinor: 19900, state: 'PENDING',
};

test('two configured payment providers retain independent currencies', () => {
  assert.deepEqual(selectPaymentChannel('telegram_bot', 'telegram_stars'), {
    allowed: true, provider: 'telegram_stars', currency: 'XTR',
  });
  assert.deepEqual(selectPaymentChannel('external_web', 'prodamus'), {
    allowed: true, provider: 'prodamus', currency: 'RUB',
  });
  validatePricedPlan(plan);
  assert.throws(() => validatePricedPlan({ ...plan, stars: 0 }));
});

test('Stars invoice is bound to trusted price and opaque order payload', () => {
  const invoice = buildStarsInvoice(starsOrder, plan, key);
  assert.equal(invoice.prices[0].amount, 250);
  assert.equal(invoice.currency, 'XTR');
  assert.equal(parseStarsPayload(invoice.payload, key), orderId);
  assert.equal(parseStarsPayload(invoice.payload, 'b'.repeat(48)), null);
  assert.equal(parseStarsPayload(invoice.payload + '0', key), null);
  assert.throws(() => buildStarsInvoice({ ...starsOrder, amount: 30 }, plan, key));
});

test('pre-checkout requires exact order and does not grant any right', () => {
  const query = {
    id: 'checkout_1', from: { id: 100001 }, total_amount: 250,
    currency: 'XTR', invoice_payload: starsPayload(orderId, key),
  };
  assert.deepEqual(validateStarsPreCheckout(query, starsOrder, key, time), { ok: true });
  assert.equal(validateStarsPreCheckout({ ...query, total_amount: 251 }, starsOrder, key, time).ok, false);
  assert.equal(validateStarsPreCheckout({ ...query, from: { id: 100002 } }, starsOrder, key, time).ok, false);
});

test('Stars success requires verified transport, charge ID and matching order', () => {
  const event = {
    currency: 'XTR', total_amount: 250, invoice_payload: starsPayload(orderId, key),
    telegram_payment_charge_id: 'charge_1',
  };
  const verified = validateStarsSuccess(event, 100001, starsOrder, key, time);
  assert.equal(verified.ok, true);
  if (verified.ok) assert.equal(verified.capture.providerTransactionId, 'charge_1');
  assert.equal(validateStarsSuccess({ ...event, total_amount: 99 }, 100001, starsOrder, key, time).ok, false);
  assert.equal(validateStarsSuccess({ ...event, is_recurring: true }, 100001, starsOrder, key, time).ok, false);
  const late = new Date(starsOrder.expiresAt.getTime() + 5000);
  assert.equal(validateStarsSuccess(event, 100001, starsOrder, key, late).ok, true);
});

test('Prodamus nested canonicalization stable and signed against changes', () => {
  const first: Fields = {
    z: 2, products: [{ name: 'Тест / VPN', quantity: 1, price: '199.00' }],
    urlSuccess: 'https://shop.example/success',
  };
  const second: Fields = {
    urlSuccess: 'https://shop.example/success',
    products: [{ price: '199.00', quantity: '1', name: 'Тест / VPN' }], z: '2',
  };
  assert.equal(canonicalProdamusJson(first), canonicalProdamusJson(second));
  const sig = signProdamus(first, key);
  assert.equal(sig, signProdamus(second, key));
  assert.equal(verifyProdamus(first, sig, key), true);
  assert.equal(verifyProdamus({ ...first, z: 4 }, sig, key), false);
});

test('Prodamus creates signed request using trusted RUB amount and title', () => {
  const url = new URL(buildProdamusLinkRequest(rubOrder, 'VPN месяц', config));
  assert.equal(url.hostname, 'merchant.payform.ru');
  assert.equal(url.searchParams.get('do'), 'link');
  assert.equal(url.searchParams.get('order_id'), orderId);
  assert.equal(url.searchParams.get('products[0][price]'), '199.00');
  assert.match(url.searchParams.get('signature') ?? '', /^[0-9a-f]{64}$/);
  assert.throws(() => buildProdamusLinkRequest(rubOrder, 'x', { ...config, formUrl: 'http://merchant.payform.ru' }));
});

test('Prodamus webhook requires signed success, order_num, sum, domain and capture', () => {
  const body: Fields = {
    payment_status: 'success', order_id: 'capture-123', order_num: orderId,
    domain: 'merchant.payform.ru', sum: '199.00', attempt: '1',
  };
  const sig = signProdamus(body, key);
  const result = verifyProdamusPayment(body, sig, rubOrder, config);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.capture.providerEventId, 'paid:capture-123');
    assert.equal(result.capture.amountMinor, 19900);
  }
  assert.equal(verifyProdamusPayment({ ...body, sum: '1.00' }, sig, rubOrder, config).ok, false);
  const wrong = { ...body, sum: '1.00' };
  assert.equal(verifyProdamusPayment(wrong, signProdamus(wrong, key), rubOrder, config).ok, false);
  const canceled = { ...body, payment_status: 'order_canceled' };
  assert.equal(verifyProdamusPayment(canceled, signProdamus(canceled, key), rubOrder, config).ok, false);
  const auto = { ...body, payment_init: 'auto' };
  assert.equal(verifyProdamusPayment(auto, signProdamus(auto, key), rubOrder, config).ok, false);
  // Prodamus retries carry a new 'attempt' but refer to the SAME capture.
  const retry = { ...body, attempt: '2' };
  const alreadyPaid = { ...rubOrder, state: 'PAID' as const };
  const repeat = verifyProdamusPayment(retry, signProdamus(retry, key), alreadyPaid, config);
  assert.equal(repeat.ok, true);
  if (repeat.ok) {
    assert.equal(repeat.capture.providerTransactionId, 'capture-123');
    assert.equal(repeat.capture.amountMinor, 19900);
    assert.notEqual(repeat.capture.payloadSha256, result.ok ? result.capture.payloadSha256 : '');
  }
  const refunded = { ...rubOrder, state: 'REFUNDED' as const };
  assert.equal(verifyProdamusPayment(retry, signProdamus(retry, key), refunded, config).ok, true);
});
