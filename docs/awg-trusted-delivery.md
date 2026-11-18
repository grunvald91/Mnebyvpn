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
