/** Owner-approved Stars durations/prices. All limits are DNS queries, never bytes. */
export const PERSONAL_DNS_QUERIES_PER_30D=1_000_000n;
export const PERSONAL_DNS_STARS_OFFERS=[
  {planId:'personal_dns_14d_stars',days:14,stars:100},
  {planId:'personal_dns_30d_stars',days:30,stars:200},
  {planId:'personal_dns_60d_stars',days:60,stars:400},
  {planId:'personal_dns_90d_stars',days:90,stars:500},
] as const;

export type PersonalDnsOffer=typeof PERSONAL_DNS_STARS_OFFERS[number];
export type DnsPublishedPlan={
  planId:string;
  product:string;
  stars:number|null;
  durationSeconds:number;
  dnsQuotaBytes:bigint|null;
  dnsQuotaQueriesPer30d?:bigint|null;
};
/** Both the checkout gate and menu use one approved tariff matrix. */
export function approvedPersonalDnsOffer(plan:DnsPublishedPlan):PersonalDnsOffer|null{
  if(plan.product!=='smart_dns'||plan.dnsQuotaBytes!==null||
     plan.dnsQuotaQueriesPer30d!==PERSONAL_DNS_QUERIES_PER_30D)return null;
  return PERSONAL_DNS_STARS_OFFERS.find(p=>p.planId===plan.planId&&
    p.days*86400===plan.durationSeconds&&p.stars===plan.stars)??null;
}
