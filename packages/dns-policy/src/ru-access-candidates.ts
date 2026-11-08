/**
 * Research catalogue (NOT automatically installed in CoreDNS).
 *
 * Separate network censorship from service-imposed regional restriction.
 * A successful TCP/TLS handshake is not proof of logged-in access.
 * No wildcard DNS rewrites: every origin must pass exact-host security gates.
 */
import type { DomainRouteRule } from './domain-routing.ts';

export type RuAccessConstraint =
  | 'russian-network-interference'
  | 'service-regional-policy'
  | 'uncertain-or-network-dependent';

export type ProductArea =
  | 'ai' | 'social' | 'messaging' | 'media' | 'developer' | 'other';

export interface RuAccessCandidate extends DomainRouteRule {
  readonly service: string;
  readonly area: ProductArea;
  readonly constraint: RuAccessConstraint;
  /** Verifiable evidence of the broad service constraint, not exact-host proof. */
  readonly evidenceUrl: string;
  /** Distinguishes catalogued candidates from successfully admitted routes. */
  readonly deployment: 'research-only';
}

/**
 * High-signal initial inventory. Complete application operation generally needs
 * more hosts (OAuth, CDN, video streams, WebSockets, etc.).
 *
 * Even "testing" entries are NOT live; all hostnames require per-host HTTPS
 * certificate, Russian ingress, DNS A/AAAA/HTTPS/SVCB, and abuse tests first.
 */
export const ruAccessCandidates: readonly RuAccessCandidate[] = Object.freeze([
  ...([
    ['discord.com','messaging'],
    ['gateway.discord.gg','messaging'],
    ['cdn.discordapp.com','messaging'],
  ] as const).map(([domain,area]) => ({
    domain,area,service:'Discord',
    constraint:'russian-network-interference' as const,
    evidenceUrl:'https://explorer.ooni.org/findings/2025-russia-blocked-discord',
    deployment:'research-only' as const,
    status:'testing' as const,
  })),
  ...([
    ['www.instagram.com','social'],['www.facebook.com','social'],
    ['static.cdninstagram.com','social'],
  ] as const).map(([domain,area]) => ({
    domain,area,service:'Meta',
    constraint:'russian-network-interference' as const,
    evidenceUrl:'https://www.top10vpn.com/research/websites-blocked-in-russia/',
    deployment:'research-only' as const,
    status:'unverified' as const,
  })),
  ...([
    ['x.com','social'],['abs.twimg.com','social'],
  ] as const).map(([domain,area]) => ({
    domain,area,service:'X',
    constraint:'russian-network-interference' as const,
    evidenceUrl:'https://www.top10vpn.com/research/websites-blocked-in-russia/',
    deployment:'research-only' as const,
    status:'unverified' as const,
  })),
  ...([
    ['bsky.app','social'],['api.bsky.app','social'],
  ] as const).map(([domain,area]) => ({
    domain,area,service:'Bluesky',
    constraint:'russian-network-interference' as const,
    evidenceUrl:'https://explorer.ooni.org/findings',
    deployment:'research-only' as const,
    status:'unverified' as const,
  })),
  ...([
    ['chatgpt.com','ai'],['auth.openai.com','ai'],
    ['cdn.oaistatic.com','ai'],['api.openai.com','ai'],
  ] as const).map(([domain,area]) => ({
    domain,area,service:'OpenAI',
    constraint:'service-regional-policy' as const,
    evidenceUrl:'https://help.openai.com/en/articles/9131992-chatgpt-and-api-services-in-unsupported-countries-and-territories',
    deployment:'research-only' as const,
    status:'unverified' as const,
  })),
  ...([
    ['claude.ai','ai'],['api.anthropic.com','ai'],
  ] as const).map(([domain,area]) => ({
    domain,area,service:'Claude',
    constraint:'uncertain-or-network-dependent' as const,
    evidenceUrl:'https://github.com/itdoginfo/allow-domains',
    deployment:'research-only' as const,
    status:'unverified' as const,
  })),
  ...([
    ['www.youtube.com','media'],['youtubei.googleapis.com','media'],
  ] as const).map(([domain,area]) => ({
    domain,area,service:'YouTube',
    constraint:'russian-network-interference' as const,
    evidenceUrl:'https://www.top10vpn.com/research/websites-blocked-in-russia/',
    deployment:'research-only' as const,
    status:'unverified' as const,
  })),
  ...([
    ['www.tiktok.com','media'],['open.spotify.com','media'],
    ['www.perplexity.ai','ai'],['archive.org','other'],
    ['www.roblox.com','other'],
  ] as const).map(([domain,area]) => ({
    domain,area,service:domain.split('.')[1] || domain,
    constraint:'uncertain-or-network-dependent' as const,
    evidenceUrl:'https://github.com/itdoginfo/allow-domains',
    deployment:'research-only' as const,
    status:'unverified' as const,
  })),
]);

/** Allow direct Russian and sensitive domains to remain separate. */
export const directOnlyRussianServices: readonly string[] = Object.freeze([
  'gosuslugi.ru','nalog.ru','fssp.gov.ru','mos.ru','rzd.ru',
  'ozon.ru','yandex.ru','vk.com','pochta.ru','sberbank.ru',
]);
