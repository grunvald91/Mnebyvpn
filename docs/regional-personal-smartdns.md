# Regional personal Smart DNS: Finland and Germany (design / NOT deployed)

## Product behavior

Offer independent entries in a country picker, one **personal DoT hostname** per enabled country. A user who installs a Finland hostname selects only the FI-approved Smart DNS egress for mapped services; Germany is a different hostname and grant. The same user can own both credentials. On Android only one system Private DNS provider hostname is active at a time. DNS alone does not make ordinary non-proxied web traffic originate from the selected country.

Existing \`<12-symbol>.dns.mnebyvpn.site\` links, including permanent owner profiles, **must not be rotated, migrated or reinterpreted**. The region feature is additive and gated separately.

## Candidate zones (not live DNS yet)

- Finland: \`<12-symbol>.fi.dns.mnebyvpn.site\`, independent entry for verified node FI217.
- Germany: \`<12-symbol>.de.dns.mnebyvpn.site\`, independent entry for verified DE egress.

These are candidate shapes, **not usable client credentials**. Each zone requires an independent wildcard A/AAAA record and CA-verified \`*.fi.dns.mnebyvpn.site\` / \`*.de.dns.mnebyvpn.site\` certificate. The existing \`*.dns.mnebyvpn.site\` certificate does not cover these nested country-specific names. Provision and renew certificates automatically through an approved DNS-01 workflow; do not repurpose or overwrite the live certificate.

\`packages/dns-policy/src/regional-personal-dot-identity.ts\` builds *unpublished* candidate identities and refuses unlisted countries. Its separate domain-separated credential digest binds the country to the bearer label. No current production path imports that file.

## Controller / database changes needed before product launch

1. Migration: separate per-country credentials for one paid entitlement, with a unique \`(entitlement_id, country_code, node_id)\` identity and independent revocation / rotation. Continue supporting existing \`personal_dns_credentials\` and \`owner_dns_links\` unchanged. A user must explicitly select each country.
2. Store *only* a hashed credential; never log or expose the bearer token. The node must validate country, node ID, entitlement revision, expiry and the currently signed grant; no cross-region replay or auto-fallback.
3. Issue only after independently verified node exit-country proof, working private DoT listener, strictly validated public wildcard TLS, a positive authorized DoT DNS response through that region, and country-specific signed controller policy on the node.
4. Keep authorization local to each node for in-flight client DoT queries: controller updates arrive asynchronously as signed snapshots, never in the connection's synchronous critical path.
5. Map only approved service domains over the selected country's proxy/egress. All other domains resolve normally. If FI fails, fail visibly rather than silently using DE while calling the link Finland.
6. Support site/Telegram bot rendering FI and DE as *separate* copy/install actions. For iOS the profile ServerName must match the chosen region. No public unauthenticated resolver and no general client/shared DoT link.

## Rollout gates

- Offline schema/identity tests, migration rollback and role permissions
- Per-node DNS A/AAAA, DNS-01 certificates, SNI ingress on TCP/853, live authorized queries and denied unknown/revoked/expired tokens
- Verified FI and DE egress only for mapped domains
- Signed grant / revoke / offline local cache and independent regional failover tests
- Canary subscriber approval before any public purchase/credential issuance

This design is complementary to FI217 AWG (VPN) preparation; it is **not** proof that new FI or DE country-specific DNS currently works.
