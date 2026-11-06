/**
 * Separate WEBSITE-only Prodamus checkout, not a payment link from Telegram.
 * Telegram Bot Platform 6.2 requires Stars for digital services inside bots.
 *
 * Do not add an unauthenticated public HTTP route accepting accountId. The
 * verified website session resolves accountId BEFORE calling this module.
 */
import { PgBillingStore,prodamusOrderFromDB } from './store.ts';
import {buildProdamusLinkRequest,type ProdamusConfig} from './prodamus.ts';

export interface TrustedWebsiteCheckout {
  /** Resolved by an actual authenticated website session, not an HTTP body. */
  accountId:string;
  requestId:string;
  planId:string;
  inviteToken?:string;
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
/** For a standalone authenticated HTTPS website checkout ONLY. */
export async function prepareWebsiteProdamusCheckout(
  authenticated:TrustedWebsiteCheckout,
  db:PgBillingStore,
  config:ProdamusConfig,
  transport:PayformLinkTransport,
):Promise<{orderId:string;paymentUrl:string;amountMinor:number}> {
  const order=await db.createWebsiteOrder(
    authenticated.accountId,authenticated.planId,authenticated.requestId,
    authenticated.inviteToken);
  const url=buildProdamusLinkRequest(prodamusOrderFromDB(order),order.planTitle,config);
  const payform=new URL(url);
  if(!approvedHost(payform.hostname))throw new Error('Unapproved configured Prodamus host');
  const result=await transport.getLink(url);
  return {orderId:order.id,paymentUrl:validateProdamusShortLink(result),amountMinor:order.amount};
}
