/**
 * Separate WEBSITE-only checkout, not a payment link from Telegram.
 * Telegram Bot Platform 6.2 requires Stars for digital services inside bots.
 *
 * Do not add an unauthenticated public HTTP route accepting accountId. The
 * verified website session resolves accountId BEFORE calling this module.
 */
import { PgBillingStore, prodamusOrderFromDB, yookassaOrderFromDB } from './store.ts';
import { buildProdamusLinkRequest, type ProdamusConfig } from './prodamus.ts';
import {
  buildYookassaPaymentRequest, validateYookassaConfirmationUrl,
  type YookassaConfig, type YookassaTransport,
} from './yookassa.ts';

export interface TrustedWebsiteCheckout {
  /** Resolved by an actual authenticated website session, not an HTTP body. */
  accountId:string;
  /** Verified account email; never read from checkout request body. */
  email?:string;
  requestId:string;
  planId:string;
  inviteToken?:string;
  renewalTargetId?:string;
}
export interface PayformLinkTransport {
  /** Requests do=link from configured Prodamus payform, with bounded timeout. */
  getLink(signedUrl:string):Promise<string>;
}
function approvedHost(hostname:string):boolean {
  return hostname==='payform.ru'||hostname.endsWith('.payform.ru');
}
export function validateProdamusShortLink(raw:string):string {
  if(raw.length>1024||raw.includes('\n')||raw.includes('\r'))
    throw new Error('Invalid Prodamus response');
  const candidate=raw.trim();
  const url=new URL(candidate);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||
     !approvedHost(url.hostname)||url.pathname.length<2)
    throw new Error('Unsafe Prodamus payment link');
  return url.toString();
}
export class OfflinePayformLinkTransport implements PayformLinkTransport {
  async getLink(_signedUrl:string):Promise<string> {
    throw new Error('Live Prodamus is disabled; inject merchant-verified website transport');
  }
}
/** Legacy Prodamus checkout helper retained for offline contract coverage. */
export async function prepareWebsiteProdamusCheckout(
  authenticated:TrustedWebsiteCheckout,
  db:PgBillingStore,
  config:ProdamusConfig,
  transport:PayformLinkTransport,
):Promise<{orderId:string;paymentUrl:string;amountMinor:number}> {
  const order=await db.createWebsiteOrder(
    authenticated.accountId,authenticated.planId,authenticated.requestId,
    authenticated.inviteToken,authenticated.renewalTargetId,'prodamus');
  const url=buildProdamusLinkRequest(prodamusOrderFromDB(order),order.planTitle,config,authenticated.email);
  const payform=new URL(url);
  if(!approvedHost(payform.hostname))throw new Error('Unapproved configured Prodamus host');
  const result=await transport.getLink(url);
  return {orderId:order.id,paymentUrl:validateProdamusShortLink(result),amountMinor:order.amount};
}

/** Primary standalone HTTPS website checkout via YooKassa API v3. */
export async function prepareWebsiteYookassaCheckout(
  authenticated: TrustedWebsiteCheckout,
  db: Pick<PgBillingStore, 'createWebsiteOrder' | 'recordYookassaPayment' | 'yookassaPaymentIdForOrder'>,
  config: YookassaConfig,
  transport: YookassaTransport,
  allowTestHost?: string,
): Promise<{ orderId: string; paymentId: string; paymentUrl: string; amountMinor: number }> {
  if (!authenticated.email) throw new Error('VERIFIED_EMAIL_REQUIRED');
  const order = await db.createWebsiteOrder(
    authenticated.accountId,
    authenticated.planId,
    authenticated.requestId,
    authenticated.inviteToken,
    authenticated.renewalTargetId,
    'yookassa',
  );
  if (order.state !== 'PENDING') {
    throw new Error('Order is no longer pending');
  }
  const existingId = typeof db.yookassaPaymentIdForOrder === 'function'
    ? await db.yookassaPaymentIdForOrder(order.id)
    : null;
  if (existingId) {
    const existing = await transport.getPayment(existingId);
    const confirmation = existing.confirmation as Record<string, unknown> | undefined;
    if (existing.status === 'pending' && confirmation?.confirmation_url) {
      return {
        orderId: order.id,
        paymentId: existingId,
        paymentUrl: validateYookassaConfirmationUrl(confirmation.confirmation_url, allowTestHost),
        amountMinor: order.amount,
      };
    }
  }
  const payload = buildYookassaPaymentRequest(
    yookassaOrderFromDB(order),
    order.planTitle,
    config,
    authenticated.email,
  );
  const created = await transport.createPayment(order.id, payload);
  if (typeof created.id !== 'string' || !/^[A-Za-z0-9_-]{10,80}$/.test(created.id)) {
    throw new Error('PAYMENT_PROVIDER_INVALID_LINK');
  }
  const confirmation = created.confirmation as Record<string, unknown> | undefined;
  const paymentUrl = validateYookassaConfirmationUrl(confirmation?.confirmation_url, allowTestHost);
  if (typeof db.recordYookassaPayment === 'function') {
    await db.recordYookassaPayment(order.id, created.id);
  }
  return {
    orderId: order.id,
    paymentId: created.id,
    paymentUrl,
    amountMinor: order.amount,
  };
}
