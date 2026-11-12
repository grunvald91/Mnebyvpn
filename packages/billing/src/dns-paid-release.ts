/**
 * Single commercial switch for paid Smart DNS and DNS+VPN offers.
 *
 * This is an operator sales setting, not a claim that a DNS relay works.
 * Other existing payment, authentication and entitlement validation remains
 * unchanged. Keep subscription enforcement in the data plane, not extra flags.
 */
export function isDnsSalesEnabled(env:Readonly<Record<string,string|undefined>>):boolean{
  return env.MNEBYDNS_PAID_SALES_ENABLED==='yes';
}
