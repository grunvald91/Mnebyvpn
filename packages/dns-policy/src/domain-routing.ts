/**
 * MNEBYDNS route admission model. Not wired to a DNS resolver or TCP ingress.
 *
 * No wildcard expansion: a "Google" vendor tag cannot prove that every domain,
 * protocol, address family, and HTTPS/SVCB path is safe to proxy.
 *
 * 'proxy-candidate' is intentionally NOT a DNS rewrite or a network permission:
 * a live SNI ingress must separately authenticate, enforce quotas and revoke.
 */
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export type RouteStatus = 'unverified' | 'testing' | 'verified' | 'disabled';
export interface DomainRouteRule {
  domain: string;
  status: RouteStatus;
  /** The exact rule revision that passed controlled DNS RR and HTTPS tests. */
  verifiedPolicyRevision?: number;
}
export interface RouteAdmitContext {
  policyRevision: number;
  ingressHealthy: boolean;
  e2eVerified: boolean;
  rrPolicyVerified: boolean;
  ingressAuthorizationVerified: boolean;
}
export type RouteDecision =
  | { route: 'direct'; reason: string }
  | { route: 'blocked'; domain: string; reason: string }
  | { route: 'proxy-candidate'; domain: string; policyRevision: number };

function canonicalDomain(raw: string): string {
  if (raw !== raw.trim() || raw.includes('*') || raw.includes('/') || raw.includes(':')) {
    throw new Error('DNS policy requires an exact, unambiguous domain');
  }
  const ascii = domainToASCII(raw.endsWith('.') ? raw.slice(0, -1) : raw).toLowerCase();
  if (!ascii || ascii.length > 253 || isIP(ascii) !== 0) {
    throw new Error('Invalid FQDN');
  }
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some(label =>
    label.length < 1 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )) throw new Error('Invalid domain labels');
  return ascii;
}

/** Build an exact-name allowlist. Duplicate names fail closed. */
export function compileDomainRoutes(rules: readonly DomainRouteRule[]): ReadonlyMap<string, DomainRouteRule> {
  const compiled = new Map<string, DomainRouteRule>();
  for (const rule of rules) {
    const domain = canonicalDomain(rule.domain);
    if (compiled.has(domain)) throw new Error('Duplicate DNS route: ' + domain);
    if (!['unverified','testing','verified','disabled'].includes(rule.status)) {
      throw new Error('Invalid route status');
    }
    if (rule.verifiedPolicyRevision !== undefined &&
        (!Number.isSafeInteger(rule.verifiedPolicyRevision) || rule.verifiedPolicyRevision < 1)) {
      throw new Error('Invalid policy revision');
    }
    compiled.set(domain, Object.freeze({ ...rule, domain }));
  }
  return compiled;
}

/**
 * Only allow verified exact domain + matching policy revision + independent
 * network and security gates. Unknown or unverified domains stay direct;
 * a verified proxy-only rule MUST NOT silently downgrade to direct on failure.
 * A live resolver/ingress must enforce "blocked" on the wire, including cache.
 */
export function decideDomainRoute(
  requestedDomain: string,
  compiledRules: ReadonlyMap<string, DomainRouteRule>,
  context: RouteAdmitContext,
): RouteDecision {
  let domain: string;
  try { domain = canonicalDomain(requestedDomain); }
  catch { return { route: 'direct', reason: 'invalid-domain' }; }
  const rule = compiledRules.get(domain);
  if (!rule) return { route: 'direct', reason: 'unlisted-domain' };
  if (rule.status !== 'verified') return { route: 'direct', reason: 'not-verified' };
  if (!Number.isSafeInteger(context.policyRevision) ||
      context.policyRevision !== rule.verifiedPolicyRevision) {
    return { route: 'blocked', domain, reason: 'stale-or-unverified-policy' };
  }
  if (!context.ingressHealthy || !context.e2eVerified || !context.rrPolicyVerified ||
      !context.ingressAuthorizationVerified) {
    return { route: 'blocked', domain, reason: 'network-or-security-gate-failed' };
  }
  return { route: 'proxy-candidate', domain, policyRevision: context.policyRevision };
}
