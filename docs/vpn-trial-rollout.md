# Telegram → VPN profile: rollout contract (2026-11-06)

Status: **code + PostgreSQL E2E verified in CI**, **production node not verified**.
This is not a commercial release gate PASS. See [release-gates](release-gates.md).

## What this change actually enables

- A signed private Telegram `/connect` or `nav:connect` request may retrieve a personal link if **all** checks pass: account ownership in PostgreSQL, `ACTIVE` entitlement, non-expired deadline, `provisioning_state.applied_revision=e.revision`, a real Remnawave user with expected deterministic username, exact revision marker and expiry, and an approved HTTPS subscription origin.
- No Bot API token is copied to the VPS. Bot webhook uses one-response Telegram API action. The personal link is only returned in the private account's callback, never written to the repository or a billing table.
- The Remnawave client implements a narrow `GET by username`, `POST create` and `PATCH update` transport. Panel write/read-back is **not** evidence that Xray Node can actually transport packets or enforce expiry during a control-plane partition.
- A free 24h trial still needs a worker + verified live VPN node before it can become `ACTIVE`. This PR does **not** enable trial offers or online payments.

## Secret configuration for future approved deployment

Place all secrets **outside public Git** in the runtime secret store, on the host where the Telegram cabinet runs.

- `REMNAWAVE_API_URL` — trusted panel origin (HTTPS; HTTP allowed only for 127.0.0.1/localhost when behind a locally managed private ingress).
- `REMNAWAVE_API_TOKEN` — scoped token (only user read/create/update; never unrestricted administrator if narrower scope is available).
- `REMNAWAVE_SQUAD_UUIDS` — comma-separated internal squad UUIDs in the approved VPN pilot.
- `VPN_SUBSCRIPTION_ORIGIN` — exact HTTPS origin of the real subscription endpoint. Tokenized subscription links may only use this origin.
- Existing `DATABASE_URL`, `TELEGRAM_WEBHOOK_SECRET_SHA256`, `MNEBYVPN_ENV=production`, `BOT_PUBLIC_INFO_ONLY=no`.

If Remnawave is absent, `/connect` must not reveal or fabricate a profile.

## Missing before a real 24-hour trial

1. Private network preflight on both VPS: running services, listener conflicts, storage, backup and return path; preserve existing workloads.
2. Verify pinned Remnawave Panel/Node/Xray version and restricted API token/real pilot squad.
3. Connect the `PgOutboxDispatcher` to an adapter that actually observes the **data plane** and proves independent hard expiry (not a panel-side timestamp). The current dispatcher is intentionally **not** configured with an adapter.
4. Exercise free trial reservation → node provisioning → actual TCP/UDP traffic → subscription retrieval in Telegram → 24h expiry; perform accelerated time tests, refund/revoke, reboot, panel/node partition, and old configured client re-connect tests.
5. Verify stale-window acceptance, protection against leaking subscriptions and actual webhook delivery; only then enable the VPN trial offer in database. Paid checkout has separate finance and legal gates.

Official API contract: https://docs.rw/api/ (Users Controller, API v3.4.7 at time of development).

## Database expiry scheduler

The dedicated `npm run start:expiry-worker` process needs the following runtime settings:
`MNEBYVPN_ENV=production`, `MNEBYVPN_EXPIRY_WORKER=enabled`, `DATABASE_URL`.

Once started, it runs `expire_due_entitlements()` each minute and drift reconciliation scheduling every five minutes. PostgreSQL atomically sets past-due entitlement state to EXPIRED and enqueues a new revision. It is safe to retry after a crash, but **this scheduler does not itself disable an existing Xray TCP/UDP stream**. That requires a real node adapter and the separately documented hard-expiry gate. Do not advertise production VPN expiry until verified on the wire.
