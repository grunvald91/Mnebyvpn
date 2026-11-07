import {
  vpnWidgetPayload, statusWidgetData, plansWidgetData,planWidgetKey,
} from '../../telegram-ui/src/widget-104.ts';
import { referralWidgetPayload } from '../../telegram-ui/src/referral-widget.ts';
import { navigationText,navigationCallback,issueStarsInvoice,startTrial,showHome,sendReservedStarsInvoice } from './bot-navigation.ts';
import {
  parseStarsPayload, validateStarsPreCheckout, validateStarsSuccess, buildStarsInvoice,
  type TelegramPreCheckout, type TelegramSuccessfulPayment,
} from './stars.ts';
import {createHash} from 'node:crypto';
import {
  canonicalProdamusJson,verifyProdamus, verifyProdamusPayment, type Fields, type ProdamusConfig,
} from './prodamus.ts';
import {
  PgBillingStore, prodamusOrderFromDB, starsOrderFromDB, starsPaymentHash, pricedPlanForOrder,
} from './store.ts';

export interface TelegramApi {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}
export interface PaymentHandlersConfig {
  starsPayloadSecret: string;
  prodamus: ProdamusConfig;
  /** Real Telegram @bot username, configured at deployment. Never invent it. */
  telegramBotUsername?: string;
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
  widget_query?: {
    id:string;
    from:{id:number};
    chat?:{id:number;type:string};
    message_id?:number;
    inline_message_id?:string;
    data:string;
  };
  shared_widget_query?: {id:string;from:{id:number};data:string;widget_id:string};
  pre_checkout_query?: TelegramPreCheckout;
}
const validUserId = (id: unknown): id is number =>
  typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"','&quot;');
const planId = (value: string): boolean => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);

/** Telegram Bot API 10.4 HTML widgets are implemented in widget-104.ts. */
export function htmlPlanList(plans: ReadonlyArray<{ planId: string; title: string; stars: number | null }>): string {
  if (!plans.length) return '<b>Тарифы пока не опубликованы.</b>';
  return '<b>Выбери пакет MNEBYVPN</b>\n\n' +
    plans.map(p => '• <b>' + escapeHtml(p.title) + '</b> — ' + p.stars + ' ⭐').join('\n');
}

async function handleVpnWidgetQuery(
  query: NonNullable<TelegramUpdate['widget_query']>,
  db: PgBillingStore, tg: TelegramApi, config: PaymentHandlersConfig
):Promise<void> {
  const process=async():Promise<string>=>{
  let answer='NOT_ALLOWED';
  const privateOrigin=Number.isSafeInteger(query.from?.id)&&query.from.id>0 &&
    query.chat?.type==='private' && query.chat.id===query.from.id &&
    Number.isSafeInteger(query.message_id) && (query.message_id??0)>0 &&
    typeof query.data==='string' && Buffer.byteLength(query.data,'utf8')<=64;
  try {
    if(privateOrigin) {
      const id=query.from.id;
      if(query.data==='view:status'||query.data==='refresh'||query.data==='view:plans') {
        const data=query.data==='view:plans'
          ? plansWidgetData(await db.plans('telegram_stars'))
          : statusWidgetData(await db.listUserPackages(id));
        try {
          await tg.call('editMessageWidgetData',{
            chat_id:id,message_id:query.message_id,chat_data:data,
          });
        } catch (error) {
          // A no-op update is already in the correct state.
          if(!/message is not modified/i.test(String(error)))throw error;
        }
        answer=data;
      } else if(/^buy:[A-Za-z0-9_-]{16}$/.test(query.data)) {
        const result=await issueStarsInvoice(id,query.data.slice(4),db,tg,
          config.starsPayloadSecret,'widget-query:'+query.id);
        answer=result==='SENT'?'INVOICE_SENT':result==='ALREADY_REQUESTED'?
          'ALREADY_REQUESTED':'PLAN_UNAVAILABLE';
      } else answer='UNKNOWN_ACTION';
    }
  } catch {
    answer='RETRY_LATER';
  }
  return answer;
  };
  // Telegram Widget requests must be answered within 15 seconds. Do not hold
  // the reply for arbitrarily slow DB calls; operation can safely finish later.
  let timeout:ReturnType<typeof setTimeout>|undefined;
  const fallback=new Promise<string>(resolve=>{
    timeout=setTimeout(()=>resolve('PROCESSING'),5500);
  });
  const answer=await Promise.race([process(),fallback]);
  if(timeout)clearTimeout(timeout);
  await tg.call('answerWidgetQuery',{widget_query_id:query.id,data:answer});
}

/** Verified Telegram update transport is a precondition of this handler. */
export async function handleTelegramUpdate(
  update: TelegramUpdate, db: PgBillingStore, tg: TelegramApi, config: PaymentHandlersConfig,
): Promise<void> {
  if(update.shared_widget_query) {
    // This bot sends non-shared personal widgets; forwarded copies never reveal
    // subscription data or trigger payment. Answer even an unexpected query.
    await tg.call('answerWidgetQuery',{
      widget_query_id:update.shared_widget_query.id,data:'NOT_ALLOWED',
    });
    return;
  }
  if(update.widget_query) {
    await handleVpnWidgetQuery(update.widget_query,db,tg,config);
    return;
  }
  const pc=update.pre_checkout_query;
  if(pc){
    // Pre-checkout must respond in 10 seconds. A timeout declines the charge;
    // it must never optimistically approve an unverified payment.
    const validation=async()=>{
      const orderId=parseStarsPayload(pc.invoice_payload,config.starsPayloadSecret);
      const record=orderId ? await db.order(orderId):null;
      return validateStarsPreCheckout(pc,
        record?.provider==='telegram_stars'?starsOrderFromDB(record):null,
        config.starsPayloadSecret);
    };
    let timer:ReturnType<typeof setTimeout>|undefined;
    const rejection={ok:false,error_message:'Проверка заказа заняла слишком много времени. Попробуйте ещё раз.'};
    const result=await Promise.race([
      validation().catch(()=>rejection),
      new Promise<typeof rejection>(resolve=>{timer=setTimeout(()=>resolve(rejection),5500);}),
    ]);
    if(timer)clearTimeout(timer);
    await tg.call('answerPreCheckoutQuery',{
      pre_checkout_query_id:pc.id,ok:result.ok,
      ...(result.ok?{}:{error_message:result.error_message}),
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

  const cb=update.callback_query;
  if(cb) {
    if(!validUserId(cb.from.id))throw new Error('Invalid callback actor');
    // Acknowledge quickly to stop the Telegram spinner before DB/network work.
    await tg.call('answerCallbackQuery',{callback_query_id:cb.id});
    if(cb.message?.chat.type!=='private'||cb.message.chat.id!==cb.from.id||
      typeof cb.data!=='string'||cb.data.length>64)return;
    try {
      const handled=await navigationCallback(cb.from.id,cb.data,cb.id,db,tg,config);
      if(!handled)await showHome(cb.from.id,tg);
    } catch(error) {
      const text=String(error).includes('PENDING_CHECKOUT_RATE_LIMIT')
        ? 'Слишком много незавершённых заказов. Завершите оплату или попробуйте позднее.'
        : String(error).includes('OFFER_CHANGED')
          ? 'Цена или срок обновились. Выберите тариф заново.'
          : 'Действие пока не удалось. Попробуйте ещё раз через меню.';
      await tg.call('sendMessage',{chat_id:cb.from.id,text});
    }
    return;
  }
  if(msg?.chat.type==='private'&&msg.text&&validUserId(msg.from?.id)&&
     msg.chat.id===msg.from.id){
    const id=msg.from.id,text=msg.text.trim();
    const referral=/^\/start\s+([rt])([A-Za-z0-9_-]{16,24})$/.exec(text);
    if(referral){
      const token=referral[2],offer=await db.referralPlan(token);
      if(!offer){
        await tg.call('sendMessage',{chat_id:id,
          text:'Предложение больше недоступно. Нажмите на кнопку выбора доступа.'});
        await showHome(id,tg);return;
      }
      try {
        if(referral[1]==='t'){
          await startTrial(id,offer.product,db,tg,token);
        } else {
          const order=await db.createTelegramOrder(id,offer.planId,
            'referral-start:'+update.update_id,token);
          // No second product/period selection. Native Telegram may still show
          // its own initial Start button, and invoice requires user confirmation.
          const delivered=await sendReservedStarsInvoice(order,db,tg,config.starsPayloadSecret);
          if(delivered==='ALREADY_REQUESTED')await tg.call('sendMessage',{
            chat_id:id,text:'Этот счёт уже запрашивался. Если он не появился, откройте новый тариф через меню.',
          });
        }
      } catch(error) {
        const message=String(error).includes('PENDING_CHECKOUT_RATE_LIMIT')
          ? 'Слишком много незавершённых счетов. Завершите один из них или вернитесь позднее.'
          : String(error).includes('Self-referral')||String(error).includes('self-owned')
            ? 'Нельзя использовать собственное приглашение.'
            : 'Не удалось открыть это предложение. Проверьте актуальную стоимость в каталоге.';
        await tg.call('sendMessage',{chat_id:id,text:message});
      }
      return;
    }
    try {
      if(await navigationText(id,text,db,tg,config))return;
    } catch {
      await tg.call('sendMessage',{chat_id:id,text:'Не удалось открыть раздел. Попробуйте ещё раз.'});
      return;
    }
    // Show familiar controls to any unrecognized message, no slash prompts.
    await showHome(id,tg);
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
  // Prodamus can be configured to notify ALL statuses. A correctly signed,
  // non-paid status is processed successfully WITHOUT granting access.
  // Respond HTTP 200 so Prodamus does not retry rejected/cancelled checkouts.
  // Keep signature and merchant-domain checks before accepting any event.
  if (!verifyProdamus(fields,signature,config.secret))
    return {statusCode:401,text:'INVALID_SIGNATURE'};
  if (fields.domain !== new URL(config.formUrl).hostname)
    return {statusCode:400,text:'MERCHANT_MISMATCH'};
  if (typeof fields.payment_status !== 'string' ||
      fields.payment_status.trim().length===0 || fields.payment_status.length>64)
    return {statusCode:400,text:'INVALID_PAYMENT_STATUS'};
  if (['refund','refunded','order_refunded'].includes(fields.payment_status)) {
    // Never acknowledge a paid-order refund without revoking its entitlement.
    // The signed merchant callback must identify the original capture.
    if (typeof fields.order_num !== 'string' || typeof fields.order_id !== 'string' ||
        fields.currency !== 'rub' || fields.order_id.length > 130)
      return {statusCode:400,text:'INVALID_REFUND'};
    const order=await db.order(fields.order_num);
    if (!order || order.provider!=='prodamus' || order.currency!=='RUB' ||
        (typeof fields.sum!=='string' || !/^[0-9]{1,12}\.[0-9]{2}$/.test(fields.sum) ||
         order.amount!==Number(fields.sum.replace('.',''))) ||
        order.id!==fields.order_num)
      return {statusCode:409,text:'UNKNOWN_REFUND'};
    const hash=createHash('sha256').update(canonicalProdamusJson(fields)).digest('hex');
    const outcome=await db.applyVerifiedRefund({
      provider:'prodamus',orderId:order.id,transactionId:fields.order_id,
      refundEventId:'refund:'+fields.order_id,
      payloadHash:hash,amount:order.amount,currency:'RUB',
    });
    // Prodamus should retry a signed refund callback if the paid credit
    // could not be durably revoked. HTTP 200 is reserved for applied or
    // confirmed idempotent refunds only.
    if(outcome==='APPLIED')return {statusCode:200,text:'REFUND_PROCESSED'};
    if(outcome==='DUPLICATE_EVENT'||outcome==='DUPLICATE_REFUND')
      return {statusCode:200,text:'REFUND_ALREADY_PROCESSED'};
    return {statusCode:503,text:'REFUND_NOT_CONFIRMED'};
  }
  if (fields.payment_status !== 'success') {
    // Signed non-paid statuses must not provision access.
    return {statusCode:200,text:'EVENT_ACCEPTED_NO_PAYMENT'};
  }
  if (typeof fields.order_num !== 'string')
    return {statusCode:400,text:'INVALID_ORDER'};
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
  if(outcome==='APPLIED')return {statusCode:200,text:'OK'};
  if(outcome==='DUPLICATE_EVENT'||outcome==='DUPLICATE_CAPTURE')
    return {statusCode:200,text:'ALREADY_PROCESSED'};
  // Never acknowledge a provider capture that wasn't durably credited.
  return {statusCode:503,text:'SETTLEMENT_NOT_CONFIRMED'};
}
