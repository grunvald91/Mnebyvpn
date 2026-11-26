# Unified 24-hour 3-in-1 trial

Owner decision (2026-11-26): one new free offer, VPN + Smart DNS for 24h and existing common Telegram Proxy links with no trial expiration. DE/FI VPN and Smart DNS, three concurrent VPN connections across regions. No changes to paid pricing, no new per-customer proxy credentials. Existing trial/paid orders are not extended or reissued.

## Implementation sequence

1. Foundation: preserve account/device uniqueness, zero-price internal order and two entitlements. Maintain old referral links (valid enabled plans only, self-referrals still rejected); permit verified legacy email cohort to reserve bundle. Keep current live offer configuration unchanged until release gates pass.
2. Catalog and quota: configure canonical bundle trial with explicit DNS quota using the existing metering model; choose quota from owner-approved/current policy, do not invent a byte-to-query conversion. Persist trial-specific 3-connection limit and use a single authoritative DE/FI count. Existing 0147 claim joins PAID order_terms; explicitly validate matching internal trial grant and exact expiry for trials, preserve verified node/peer and paid checks. Do not advertise shared admission until real DE/FI enforcement verified.
3. Activation: 0009/0132 currently start the order-wide clock on the first observed enable. Design a two-phase readiness transition that does not deadlock provisional adapters; both VPN and DNS must be ready before the shared 24h clock starts. Verify DE/FI profiles, exact common expiry, retries and rollback; no indefinite provisional access.
4. Website: update server OTP, /api/trial, catalog, journey/app, cabinet and referral resume to request bundle. Accept legacy client product tokens as compatibility aliases for new bundle reservations; retain existing orders and old recovery records. Replace VPN-only CTA and render both entitlements. Expose only the existing designated shared Telegram Proxy routes, not the paid-only personalized credentials or the admin configuration. Do not change paid proxy access.
5. Telegram: route trial:vpn and old trial callbacks to bundle, update menu/ready notifications and account view. Include the designated common proxy links. Verify both ready entitlements before stating package ready.
6. Email recovery: switch new pending requests, including LEGACY_EMAIL, to bundle. Keep waiting records tied to their actual order (including earlier VPN-only trials); send truthful ready email once, after all required node confirmations. No duplicate grants. Update invite and ready email wording.
7. Expiry/renewal: revoke VPN/DNS at canonical deadline; common Telegram Proxy unaffected. Verify expired link denial and no changes to paid orders; evaluate credential retention when purchasing a bundle rather than promise it unconditionally.
8. Release: migration and unit/integration tests; verify one order/two entitlements, parallel claims, historical cohort, referral continuity, denied fourth connection across nodes, no premature activation, expired credentials, proxy link still valid, renewal regression. Require live server checks before enabling bundle-only trial offer and deployment verification after CI/merge.

## Current branch scope

The branch now includes billing, joint activation, website, Telegram and email recovery changes (0160–0162). No offer flags have been enabled in production by this branch.

### Cross-service email release dependency

- Gateway change: https://github.com/grunvald91/booking_bot/pull/171. Deploy and verify the ServGo gateway accepts the new signed `bundle_trial_ready` and `bundle_trial_recovery_invite` kinds before turning on the bundle offer. Retain existing OTP and VPN-only formats.
- 0162 snapshots previously missed verified-email accounts without prior access, trial or device claim, excludes reviewer accounts and preserves existing queue rows. These new rows are dormant until the bundle offer is enabled and the updated worker claims them. The worker preserves explicitly selected bundle requests even when the offer is disabled; existing WAITING requests remain tied to their actual grant.
- Ready mail is selected from the actual canonical order only after both final VPN/DNS acknowledgements for bundles. SMTP acceptance is not proof of inbox delivery. A lost gateway response after successful SMTP acceptance may still cause a duplicate on a retry; gateway-level stable delivery idempotency remains a separate release-review item.
- Before rollout verify the migration and worker on disposable PostgreSQL, then validate eligible account counts without exporting email addresses. Do not trigger real mail sends during CI.

## Source references

- db/migrations/0007_trials_and_throttle.sql
- db/migrations/0132_yookassa_and_3in1_catalog.sql
- db/migrations/0147_vpn_shared_connection_leases.sql
- db/migrations/0159_fi_dns_trial_eligibility.sql
- packages/billing/src/store.ts
- packages/web/src/website-vpn-trial-recovery.ts
- apps/web/src/server.ts
- apps/service/src/telegram-cabinet-server.ts
