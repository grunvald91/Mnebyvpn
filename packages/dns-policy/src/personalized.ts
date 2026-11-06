/**
 * Isolated Smart DNS POLICY MODEL, not a deployed resolver or proxy.
 *
 * A destination IPv6 is a transferable bearer capability. It belongs to one
 * purchased package for life and is NEVER recycled to another package, even
 * after TTL expiry or revoked connections. Incoming traffic still requires
 * live quota/expiry validation on the ingress (not implemented here).
 */
import { isIP } from 'node:net';

function normalizeIPv6(value: string): string {
  if (isIP(value) !== 6) throw new Error('Invalid IPv6');
  // WHATWG URL parser normalizes equivalent textual spellings of the same IP.
  const host = new URL('http://[' + value + ']/').hostname;
  return host.slice(1, -1);
}

export class PermanentIngressAddresses {
  private readonly ownerByAddress = new Map<string, string>();
  private readonly addressByPackage = new Map<string, string>();
  private readonly revoked = new Set<string>();

  bind(packageId: string, destinationIPv6: string): void {
    if (!packageId || isIP(destinationIPv6) !== 6) throw new Error('Invalid package or IPv6');
    const address = normalizeIPv6(destinationIPv6);
    const existingOwner = this.ownerByAddress.get(address);
    if (existingOwner && existingOwner !== packageId) {
      throw new Error('Address permanently assigned to a different package');
    }
    const oldAddress = this.addressByPackage.get(packageId);
    if (oldAddress && oldAddress !== address) {
      throw new Error('Changing an assigned address requires a separate reviewed migration');
    }
    if (this.revoked.has(packageId)) throw new Error('Revoked package cannot be reassigned');
    this.ownerByAddress.set(address, packageId);
    this.addressByPackage.set(packageId, address);
  }

  revoke(packageId: string): void {
    this.revoked.add(packageId);
    // Permanently keep ownerByAddress AND addressByPackage as tombstones.
  }

  addressFor(packageId: string): string | null {
    if (this.revoked.has(packageId)) return null;
    return this.addressByPackage.get(packageId) ?? null;
  }

  /** Only a candidate subscription locator. NOT a security decision. */
  packageForIngressIP(address: string): string | null {
    if (isIP(address) !== 6) return null;
    const id = this.ownerByAddress.get(normalizeIPv6(address));
    return id && !this.revoked.has(id) ? id : null;
  }
}

export interface DnsQuestion {
  name: string;
  rrType: 'A' | 'AAAA' | 'CNAME' | 'HTTPS' | 'SVCB' | 'OTHER';
}
export interface UpstreamAnswer {
  name: string;
  rrType: DnsQuestion['rrType'];
  values: readonly string[];
  ttlSeconds: number;
}
export interface DnsPolicyContext {
  packageId: string;
  policyRevision: number;
  entitlementRevision: number;
  authorized: boolean;
  expiresAt: Date;
  allowedDomains: ReadonlySet<string>;
}
export type DnsDecision =
  | { mode: 'upstream'; answer: UpstreamAnswer; cache: 'upstream-only' }
  | {
      mode: 'personal-ipv6-test-only';
      answer: UpstreamAnswer;
      packageId: string;
      entitlementRevision: number;
      policyRevision: number;
      cache: 'never-shared-no-store';
    };

/**
 * Takes an ALREADY CACHED/RESOLVED unmodified upstream answer and personalizes
 * strictly AFTER the shared cache. Neither personal result nor profile/token
 * is ever written to CoreDNS's default shared answer cache.
 *
 * Not a DNS RR implementation: A/HTTPS/SVCB/DNSSEC consistency remains a
 * BLOCKING integration gate before turning on Smart DNS rewrite.
 */
export function personalizeDnsAfterSharedCache(
  question: DnsQuestion,
  upstream: UpstreamAnswer,
  context: DnsPolicyContext,
  registry: PermanentIngressAddresses,
  now = new Date(),
): DnsDecision {
  const fallback: DnsDecision = { mode: 'upstream', answer: upstream, cache: 'upstream-only' };
  if (question.name.toLowerCase().replace(/\.$/, '') !== upstream.name.toLowerCase().replace(/\.$/, '')
      || upstream.rrType !== question.rrType) throw new Error('Upstream answer/question mismatch');
  if (question.rrType !== 'AAAA' || !context.authorized
      || context.expiresAt.getTime() <= now.getTime()
      || !context.allowedDomains.has(question.name.toLowerCase().replace(/\.$/, ''))) return fallback;
  const address = registry.addressFor(context.packageId);
  if (!address) return fallback;
  return {
    mode: 'personal-ipv6-test-only',
    answer: { name: upstream.name, rrType: 'AAAA', values: [address], ttlSeconds: Math.min(upstream.ttlSeconds, 30) },
    packageId: context.packageId,
    entitlementRevision: context.entitlementRevision,
    policyRevision: context.policyRevision,
    cache: 'never-shared-no-store',
  };
}
