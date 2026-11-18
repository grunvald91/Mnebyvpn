# AWG 3.1 trusted-controller delivery (disabled by default)

Source: packages/provisioning/src/awg-trusted-ssh-delivery.ts.

A server-side trusted worker can call deliverNextAwgCommand after connecting to the production PostgreSQL database. It: checks protected controller SSH identity and independently pinned host key, claims a signed AWG command from the existing 40-second outbox, sends that JSON on SSH stdin to Nodekit, receives a signed node receipt, and calls acknowledgeAwgCommand to verify the enrolled node signature plus the current billing revision and release gates. It does not expose an HTTP endpoint or publish a customer profile.

## Deployment boundary

- This code is a transport library, not an automatically active worker. It is not called from browser, Telegram bot, GitHub Actions or LLM agents.
- The controller's Ed25519 private signing key remains ONLY on the trusted controller host. The node gets the public controller SPKI at a separate, reviewed enrollment; the SSH private key also stays on the controller.
- The SSH host key must already be pinned in an independent known_hosts file for the HostKeyAlias fi.mnebyvpn.site, no TOFU or password fallback. The client uses strict verification, a dedicated key, disables forwarding and uses a fixed reviewed root@217.11.167.91 endpoint.
- Root-only command JSON is sent through stdin; it is not passed as SSH argument or written to GitHub Actions logs. Temporary files are placed in /run on the node, with a shell trap for cleanup.
- A signed acknowledgement means that the node verified and applied a request under its own watchdog; a DB acknowledgement does NOT independently establish external VPN performance or publish credentials.
- Delivery errors intentionally leave outbox claimed until expiry; the next signed lease must advance revision. The on-node watchdog enforces lease expiry independently of controller availability.
- Strict current limitation: only FI test node and 10.73.91.0/24; multi-country IPAM, separate controller service account, hardening and canary release are still required.

Next: deploy this library inside a trusted central-controller process with dedicated database roles, sign/verify keys, finite queue worker interval, delivery receipt audit, E2E service monitoring, and explicit release authorization. No secrets are created here.


## Prepared private worker (not deployed)

`apps/service/src/awg-controller-delivery-worker.ts` is a separate trusted
worker entrypoint. `npm run start:awg-delivery-worker` does not deploy,
enable systemd, publish users or change any release flag.

Deploy it ONLY in a segregated root-only component on the existing RU188
controller after
node enrollment, E2E evidence and explicit owner approval.
Startup fails unless run as root with `MNEBYVPN_ENV=production` and
`MNEBYVPN_AWG_DELIVERY_WORKER=enabled`. Required on that private host:

- `DATABASE_URL`: canonical PostgreSQL with a restricted role.
- `AWG_CONTROLLER_SIGNING_KEY_FILE`: root-owned Ed25519 private PEM file, mode 0600.
- `AWG_CONTROLLER_PUBLIC_SHA256`: independently approved lowercase hex
  SHA-256 of its public DER SPKI, never derived automatically as an approval.
- `AWG_CONTROLLER_SSH_IDENTITY_FILE`: root-owned controller-only SSH key.
- `AWG_CONTROLLER_SSH_KNOWN_HOSTS_FILE`: root-owned known_hosts entry with
  independently pinned `fi.mnebyvpn.site` HostKeyAlias. No TOFU.

The worker requires already-applied outbox/enrollment migrations, processes
one command at a time in 5-second polling, validates signed receipt through
the existing transactional controller code, logs only aggregate statuses and
stops after three consecutive delivery errors. No HTTP listener or client
private key generator exists. Stale grants must be reissued after billing
verification; outbox retries alone cannot resurrect expired commands.

The reviewed FI SSH command now passes `--node-id`, `--mode apply` and
`--command` to the SAME Python invocation. A regression test guards
against the previous accidental shell-semicolon command split.

Still required before enabling: deployment of the trusted controller,
least-privilege database role, independent signing/SSH key provisioning,
enrollment challenge, periodic short-lease renewal scheduler, external
client E2E, monitoring/alerts and separate customer-profile release gate.
Merely merging this worker does not complete any of these prerequisites.


## Existing production authority

RU188 `188.120.254.223` already hosts the MNEBYVPN site, Telegram bot,
PostgreSQL and provisioning workers. The AWG signing worker is a separate
**root-only process on RU188**, NOT a new controller server and NOT an
extension loaded by the public web container. Current code is not proof
that any root-only signing key or FI enrollment exists there. Telegram
proxy is a distinct Telemt/MTProto component on DE89 and needs its own
per-customer lifecycle, not this AWG outbox worker.
