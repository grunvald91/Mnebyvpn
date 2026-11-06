/**
 * Channel policy for MNEBYVPN digital goods.
 * Telegram's rules require Stars (XTR) for digital sales in bots/mini apps.
 * Prodamus is restricted to checkout initiated on an independent external site.
 * Sources: https://core.telegram.org/bots/payments-stars
 */
export type PaymentProvider = 'telegram_stars' | 'prodamus';
export type CheckoutSurface = 'telegram_bot' | 'telegram_mini_app' | 'external_web';

export type ChannelSelection =
  | { allowed: true; provider: PaymentProvider; currency: 'XTR' | 'RUB' }
  | { allowed: false; reason: 'DIGITAL_GOODS_TELEGRAM_STARS_ONLY' | 'UNSUPPORTED_CHANNEL' };

export function selectPaymentChannel(surface: CheckoutSurface, provider: PaymentProvider): ChannelSelection {
  if (surface === 'telegram_bot' || surface === 'telegram_mini_app') {
    return provider === 'telegram_stars'
      ? { allowed: true, provider, currency: 'XTR' }
      : { allowed: false, reason: 'DIGITAL_GOODS_TELEGRAM_STARS_ONLY' };
  }
  if (surface === 'external_web' && provider === 'prodamus') {
    return { allowed: true, provider, currency: 'RUB' };
  }
  return { allowed: false, reason: 'UNSUPPORTED_CHANNEL' };
}

export interface PricedPlan {
  planId: string;
  product: 'vpn' | 'smart_dns' | 'bundle';
  title: string;
  /** Independent integer prices. Never calculate XTR from RUB with guessed exchange rates. */
  rubMinor: number | null;
  stars: number | null;
  durationSeconds: number;
  /** Licensed device slots, independent of VPN wire-level connection limits. */
  deviceLimit?: number;
  dnsQuotaBytes: bigint | null;
}
export function validatePricedPlan(plan: PricedPlan): void {
  if (!plan.planId || !plan.title || !Number.isSafeInteger(plan.durationSeconds) || plan.durationSeconds <= 0) {
    throw new Error('Invalid plan');
  }
  for (const amount of [plan.rubMinor, plan.stars]) {
    if (amount !== null && (!Number.isSafeInteger(amount) || amount <= 0)) throw new Error('Invalid plan price');
  }
  if (plan.product !== 'vpn' && (plan.dnsQuotaBytes === null || plan.dnsQuotaBytes <= 0n)) {
    throw new Error('Smart DNS needs an explicitly configured positive quota');
  }
  if (plan.product === 'vpn' && plan.dnsQuotaBytes !== null) throw new Error('Unexpected DNS quota');
}
