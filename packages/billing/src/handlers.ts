import { createHash } from 'node:crypto';
import {
  parseStarsPayload, validateStarsPreCheckout, validateStarsSuccess, buildStarsInvoice,
  type TelegramPreCheckout, type TelegramSuccessfulPayment,
} from './stars.ts';
import {
  verifyProdamusPayment, type Fields, type ProdamusConfig,
} from './prodamus.ts';
import {
  PgBillingStore, prodamusOrderFromDB, starsOrderFromDB, starsPaymentHash,
} from './store.ts';

export interface TelegramApi {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}
export interface PaymentHandlersConfig {
  starsPayloadSecret: string;
  prodamus: ProdamusConfig;
}
export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    from?: { id: number };
    text?: string;
    successful_payment?: TelegramSuccessfulPayment;
    refunded_payment?: {
      currency: string; total_amount: number;
      invoice_payload: string; telegram_payment_charge_id: string;
    };
  };
  callback_query?: {
    id: string; from: { id: number };
    data?: string;
    message?: { chat: { id: number; type: string } };
  };
  pre_checkout_query?: TelegramPreCheckout;
}
const validUserId = (id: unknown): id is number =>
  typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"','&quot;');
const planId = (value: string): boolean => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);

/** HTMLBubbles are NOT documented as a stable Bot API method; never assume that runtime. */
export interface ExperimentalBubbleRenderer {
  renderPlanList?(plans: ReadonlyArray<{ id: string; title: string; price: number }>): unknown;
}
export function htmlPlanList(plans: ReadonlyArray<{ planId: string; title: string; stars: number | null }>): string {
  if (!plans.length) return '<b>Тарифы пока не опубликованы.</b>';
  return '<b>Выбери пакет MNEBYVPN</b>\n\n' +
    plans.map(p => '• <b>' + escapeHtml(p.title) + '</b> — ' + p.stars + ' ⭐').join('\n');
}

/** Verified Telegram update transport is a precondition of this handler. */
export async function handleTelegramUpdate(
  update: TelegramUpdate, db: PgBillingStore, tg: TelegramApi, config: PaymentHandlersConfig,
): Promise<void> {
  const pc = update.pre_checkout_query;
  if (pc) {
    const orderId = parseStarsPayload(pc.invoice_payload, config.starsPayloadSecret);
    const record = orderId ? await db.order(orderId) : null;
    const result = validateStarsPreCheckout(pc,
      record?.provider === 'telegram_stars' ? starsOrderFromDB(record) : null,
      config.starsPayloadSecret);
    await tg.call('answerPreCheckoutQuery', {
      pre_checkout_query_id: pc.id, ok: result.ok,
      ...(result.ok ? {} : { error_message: result.error_message }),
    });
    return;
  }
  const msg = update.message;
  if (msg?.refunded_payment) {
    // Only verified Telegram webhook transport, not a client-supplied event.
    if (msg.chat.type!=='private' || !validUserId(msg.chat.id))
      throw new Error('Unexpected refund chat');
    const refund=msg.refunded_payment;
    const orderId=parseStarsPayload(refund.invoice_payload,config.starsPayloadSecret);
    const order=orderId ? await db.order(orderId) : null;
    if(!order || order.provider!=='telegram_stars' || order.currency!=='XTR' ||
       order.telegramUserId!==msg.chat.id || refund.currency!=='XTR' ||
       !Number.isSafeInteger(refund.total_amount) || order.amount!==refund.total_amount ||
       !refund.telegram_payment_charge_id || refund.telegram_payment_charge_id.length>160)
      throw new Error('Refund event mismatched');
    const status=await db.applyVerifiedRefund({
      provider:'telegram_stars',orderId:order.id,transactionId:refund.telegram_payment_charge_id,
      refundEventId:'refund:'+refund.telegram_payment_charge_id,
      payloadHash:starsPaymentHash(refund),amount:order.amount,currency:'XTR',
    });
    if(status==='APPLIED') {
      try {
        await tg.call('sendMessage',{chat_id:msg.chat.id,
          text:'↩️ Возврат подтверждён. Право в базе отозвано; ожидается синхронизация узлов.'});
      } catch { /* do not roll back confirmed refund on notification failure */ }
    }
    return;
  }
  if (msg?.successful_payment) {
    if (!validUserId(msg.from?.id) || msg.chat.type !== 'private' || msg.chat.id !== msg.from.id)
      throw new Error('Unexpected Telegram payment sender');
    const orderId = parseStarsPayload(msg.successful_payment.invoice_payload, config.starsPayloadSecret);
    const record = orderId ? await db.order(orderId) : null;
    const verified = validateStarsSuccess(
      msg.successful_payment, msg.from.id,
      record?.provider === 'telegram_stars' ? starsOrderFromDB(record) : null,
      config.starsPayloadSecret);
    if (!verified.ok) throw new Error('Telegram successful_payment mismatch: '+verified.reason);
    const status = await db.settleVerified({
      provider: 'telegram_stars', orderId: verified.capture.orderId,
      providerTransactionId: verified.capture.providerTransactionId,
      providerEventId: verified.capture.providerEventId,
      amount: verified.capture.amount, currency: 'XTR',
      payloadHash: starsPaymentHash(msg.successful_payment),
    });
    // Required durable write is completed before sending a non-critical message.
    if (status === 'APPLIED') {
      // The durable settlement must not be retried just because a message fails.
      try {
        await tg.call('sendMessage', {
          chat_id: msg.chat.id,
          text: '✅ Оплата подтверждена. Пакет зарегистрирован. Выдача доступа — после подключения сети.',
        });
      } catch {
        // Delivery of the receipt is non-critical; notify from support sweep.
      }
    }
    return;
  }
  const cb = update.callback_query;
  if (cb) {
    if (!validUserId(cb.from.id)) throw new Error('Invalid Telegram actor');
    try {
      if (!cb.message || cb.message.chat.type !== 'private' || cb.message.chat.id !== cb.from.id ||
          !cb.data?.startsWith('buy:')) return;
      const id = cb.data.slice(4);
      if (!planId(id)) return;
      const plan = await db.plan(id);
      if (!plan || plan.stars === null) return;
      const order = await db.createTelegramOrder(cb.from.id, id, 'tg-callback:'+cb.id);
      await tg.call('sendInvoice', { ...buildStarsInvoice(starsOrderFromDB(order), plan, config.starsPayloadSecret) });
    } finally {
      await tg.call('answerCallbackQuery',{callback_query_id: cb.id});
    }
    return;
  }
  if (msg?.chat.type === 'private' && msg.text && validUserId(msg.from?.id)
      && msg.chat.id === msg.from.id) {
    if (msg.text === '/my' || msg.text === '/status') {
      const packages=await db.listUserPackages(msg.from.id);
      const html=packages.length
        ? '<h3>Мои пакеты</h3>' + packages.map((p,i)=>{
            const state=p.state==='ACTIVE'?'Активен':p.state==='REFUNDED'?'Возврат':
              p.state==='EXPIRED'?'Истёк':'Ожидает подключения';
            const expires=p.expiresAt?.toISOString().slice(0,10)??'—';
            const quota=p.quotaLimitBytes===null?'—':
              String(p.quotaLimitBytes-p.quotaUsedBytes)+' байт';
            return '<p><b>Пакет '+(i+1)+' · '+(p.product==='vpn'?'VPN':'MNEBYDNS')+
              '</b><br>Статус: '+state+'<br>До: '+expires+
              '<br>Остаток квоты: '+quota+'</p>';
          }).join('')
        : '<h3>Мои пакеты</h3><p>У вас пока нет оплаченных пакетов. Выберите тариф командой /plans.</p>';
      await tg.call('sendRichMessage',{chat_id:msg.chat.id,rich_message:{html}});
    } else if (msg.text.startsWith('/start') || msg.text.startsWith('/plans')) {
      const plans = await db.plans('telegram_stars');
      const available = plans.filter(p => p.stars !== null);
      const html = '<h3>Выбери пакет MNEBYVPN</h3>' +
        (available.length ? available.map(p =>
          '<p><b>'+escapeHtml(p.title)+'</b> — '+p.stars+' ⭐</p>' +
          '<tg-button-row><tg-button type="callback_data" style="primary" data="buy:'+p.planId+'">Купить '+p.stars+' ⭐</tg-button></tg-button-row>'
        ).join('') : '<p>Тарифы пока не опубликованы.</p>');
      // Documented Bot API 10.3 rich content + inline buttons (NOT HTMLBubbles).
      await tg.call('sendRichMessage', {
        chat_id: msg.chat.id,
        rich_message: { html },
      });
    } else if (msg.text.startsWith('/paysupport') || msg.text.startsWith('/support')) {
      await tg.call('sendMessage', { chat_id: msg.chat.id,
        text: 'Поддержка платежей: напишите администратору проекта. Контакт публикуется при запуске.' });
    } else if (msg.text.startsWith('/terms')) {
      await tg.call('sendMessage', { chat_id: msg.chat.id,
        text: 'Условия покупки и возврата будут опубликованы перед началом продаж.' });
    }
  }
}
export interface DeliveryResult { statusCode: number; text: string }
/**
 * Verified Prodamus delivery must be represented as parsed signed form fields
 * plus its original HTTP Sign header. Never accept success_url as payment proof.
 */
export async function handleProdamusDelivery(
  fields: Fields, signature: string, db: PgBillingStore, config: ProdamusConfig
): Promise<DeliveryResult> {
  if (typeof fields.order_num !== 'string') return {statusCode:400,text:'INVALID_ORDER'};
  const record = await db.order(fields.order_num);
  const checked = verifyProdamusPayment(fields, signature,
    record?.provider === 'prodamus' ? prodamusOrderFromDB(record) : null, config);
  if (!checked.ok) return {statusCode:400,text:checked.reason};
  const outcome = await db.settleVerified({
    provider:'prodamus',
    orderId: checked.capture.orderId,
    providerTransactionId: checked.capture.providerTransactionId,
    providerEventId: checked.capture.providerEventId,
    amount: checked.capture.amountMinor,
    currency:'RUB',
    payloadHash: checked.capture.payloadSha256,
  });
  return {
    statusCode:200,
    text: outcome === 'APPLIED' ? 'OK' : 'ALREADY_PROCESSED',
  };
}
