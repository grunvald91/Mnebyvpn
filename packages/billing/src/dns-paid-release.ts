/**
 * Commercial release guard for transparent paid SmartDNS/SNI.
 *
 * Never infer readiness from DNS answers, TLS alone, payment availability,
 * a populated plan, or a single web option. Defaults to closed.
 *
 * Each operator attestation must be backed by dated REAL E2E evidence linked
 * in the release-gates record before production env is allowed to contain it.
 */
export const DNS_PAID_REQUIRED_ATTESTATIONS=[
  'WEB_DNS_PAID_PROVIDER_PREFIX_ROUTED_E2E',
  'WEB_DNS_PAID_UNIQUE_INGRESS_E2E',
  'WEB_DNS_PAID_QUOTA_REVOCATION_E2E',
  'WEB_DNS_PAID_DOH_DOT_AUTH_E2E',
  'WEB_DNS_PAID_IPV4_ONLY_CLIENT_E2E',
  'WEB_DNS_PAID_SHARED_IPV4_BYPASS_CLOSED',
  'WEB_DNS_PAID_END_USER_APP_E2E',
  'WEB_DNS_PAID_SETTLEMENT_REVIEWED',
  'WEB_DNS_PAID_RELEASE_APPROVED',
] as const;

export function paidSmartDnsCheckoutReady(
  env:Readonly<Record<string,string|undefined>>,
  generalCheckoutReady:boolean,
  networkVerified:boolean,
  onWireMeteringVerified:boolean,
):boolean{
  return generalCheckoutReady===true && networkVerified===true &&
    onWireMeteringVerified===true &&
    DNS_PAID_REQUIRED_ATTESTATIONS.every(key=>env[key]==='yes');
}
