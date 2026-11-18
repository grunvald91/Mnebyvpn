import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYookassaPaymentRequest,
  isAllowedYookassaWebhookIp,
  parseYookassaNotification,
  validateYookassaConfirmationUrl,
  verifyYookassaPaymentObject,
  verifyYookassaRefundObject,
  type YookassaConfig,
  type YookassaOrder,
} from '../packages/billing/src/yookassa.ts';

const orderId = '11111111-1111-4111-8111-111111111111';
const config: YookassaConfig = {
  shopId: '123456',
  secretKey: 'live_test_secret_key_for_unit_tests_only',
  returnUrl: 'https://mnebyvpn.site/payment/return',
  apiOrigin: 'https://api.yookassa.ru',
};
const rubOrder: YookassaOrder = {
  id: orderId,
  provider: 'yookassa',
  currency: 'RUB',
  amountMinor: 39900,
  state: 'PENDING',
};

test('YooKassa payment request uses exact server RUB price and 54-FZ receipt', () => {
  const built = buildYookassaPaymentRequest(
    rubOrder,
    'Экосистема «3 в 1» · 30 дней',
    config,
    'buyer@example.com',
  );
  assert.deepEqual(built.amount, { value: '399.00', currency: 'RUB' });
  assert.equal(built.capture, true);
  assert.deepEqual(built.metadata, { order_id: orderId });
  const receipt = built.receipt as {
    customer: { email: string };
    items: Array<{ amount: { value: string; currency: string } }>;
  };
  assert.equal(receipt.customer.email, 'buyer@example.com');
  assert.equal(receipt.items[0].amount.value, '399.00');
  const confirmation = built.confirmation as { type: string; return_url: string };
  assert.equal(confirmation.type, 'redirect');
  const ret = new URL(confirmation.return_url);
  assert.equal(ret.origin + ret.pathname, config.returnUrl);
  assert.equal(ret.searchParams.get('order'), orderId);
});

test('YooKassa confirmation URL validation rejects untrusted hosts and non-HTTPS origins', () => {
  assert.equal(
    validateYookassaConfirmationUrl('https://yoomoney.ru/checkout/payments/v2/contract?orderId=abc'),
    'https://yoomoney.ru/checkout/payments/v2/contract?orderId=abc',
  );
  assert.equal(
    validateYookassaConfirmationUrl('https://pay.yookassa.ru/checkout/123'),
    'https://pay.yookassa.ru/checkout/123',
  );
  assert.throws(() => validateYookassaConfirmationUrl('http://yoomoney.ru/checkout/123'));
  assert.throws(() => validateYookassaConfirmationUrl('https://evil.example/checkout/123'));
  assert.equal(
    validateYookassaConfirmationUrl('http://127.0.0.1:9000/mock-pay', '127.0.0.1'),
    'http://127.0.0.1:9000/mock-pay',
  );
});

test('YooKassa notification parser validates supported event types', () => {
  const paid = parseYookassaNotification({
    type: 'notification',
    event: 'payment.succeeded',
    object: {
      id: '2d8a1f00-000f-5000-8000-100000000001',
      status: 'succeeded',
      paid: true,
      amount: { value: '399.00', currency: 'RUB' },
      metadata: { order_id: orderId },
    },
  });
  assert.equal(paid?.event, 'payment.succeeded');
  assert.equal(paid?.objectId, '2d8a1f00-000f-5000-8000-100000000001');
  assert.equal(paid?.metadataOrderId, orderId);
  assert.equal(parseYookassaNotification({ type: 'notification', event: 'payment.waiting_for_capture', object: { id: '2d8a1f00-000f-5000' } })?.event, 'payment.waiting_for_capture');
  assert.equal(parseYookassaNotification({ type: 'notification', event: 'payment.unknown', object: { id: '2d8a1f00-000f-5000' } }), null);
  assert.equal(parseYookassaNotification({}), null);
});

test('YooKassa payment and refund verification enforce exact amount, RUB currency and order binding', () => {
  const paymentObj = {
    id: '2d8a1f00-000f-5000-8000-100000000001',
    status: 'succeeded',
    paid: true,
    amount: { value: '399.00', currency: 'RUB' },
    metadata: { order_id: orderId },
  };
  const checked = verifyYookassaPaymentObject(paymentObj, rubOrder);
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.equal(checked.capture.amount, 39900);
    assert.equal(checked.capture.providerTransactionId, paymentObj.id);
    assert.equal(checked.capture.providerEventId, 'paid:' + paymentObj.id);
  }
  assert.equal(verifyYookassaPaymentObject({ ...paymentObj, paid: false }, rubOrder).ok, false);
  assert.equal(verifyYookassaPaymentObject({ ...paymentObj, amount: { value: '1.00', currency: 'RUB' } }, rubOrder).ok, false);
  assert.equal(verifyYookassaPaymentObject({ ...paymentObj, amount: { value: '399.00', currency: 'USD' } }, rubOrder).ok, false);
  assert.equal(verifyYookassaPaymentObject({ ...paymentObj, metadata: { order_id: 'other' } }, rubOrder).ok, false);

  const refundChecked = verifyYookassaRefundObject(
    {
      id: 'refund-101',
      status: 'succeeded',
      payment_id: paymentObj.id,
      amount: { value: '399.00', currency: 'RUB' },
    },
    { ...rubOrder, state: 'PAID' },
  );
  assert.equal(refundChecked.ok, true);
  if (refundChecked.ok) {
    assert.equal(refundChecked.refund.refundEventId, 'refund:refund-101');
  }
});

test('YooKassa webhook IP allowlist accepts official CIDR blocks including IPv4-mapped IPv6', () => {
  assert.equal(isAllowedYookassaWebhookIp('185.71.76.5'), true);
  assert.equal(isAllowedYookassaWebhookIp('::ffff:185.71.77.10'), true);
  assert.equal(isAllowedYookassaWebhookIp('77.75.156.11'), true);
  assert.equal(isAllowedYookassaWebhookIp('2a02:5180::1234'), true);
  assert.equal(isAllowedYookassaWebhookIp('192.0.2.1'), false);
});
