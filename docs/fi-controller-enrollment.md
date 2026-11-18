# FI trusted-controller enrollment — one-shot private execution

Status: **implemented as code, NOT deployed**. No customer subscriptions or
VPN/DNS/proxy services are activated by this workflow.

## Controller-side contract

- `packages/provisioning/src/fi-enrollment-ssh.ts` checks an independently
  reviewed FI Ed25519 public node SPKI (SHA256:
  `c3689b687e8888d15e3ece8e45cf7d01672b9dadb77b1963a7871ffd8e967ed9`)
  from a root-owned protected file, never from SSH output or untrusted webhook.
- Requires a distinct protected SSH private key and an independently pinned
  root-owned `known_hosts` entry for `fi.mnebyvpn.site`; no password,
  TOFU, forwarding, or arbitrary remote command. A forced-command
  `authorized_keys` rule must map the dedicated key ONLY to the reviewed
  `nodekit/fi_enrollment_ssh.py` script. The controller deliberately
  asks remote SSH to run `false`, so an unrestricted login should fail.
- Calls the existing DB `beginNodeEnrollment` only when the inventory
  is already `approved` for this precise FI node and public key.
  Sends the one-use five-minute **controller-signed** challenge on SSH stdin,
  receives a signed node possession proof, checks its entire shape and
  signature, then calls `completeNodeEnrollment` for the **single-use**
  PostgreSQL challenge/identity update.
- Any failure before the node proof means *no completed enrollment*.
  The existing unconsumed challenge must expire; never rotate identities,
  mark the node verified, or repeat with a synthetic success record.

## Required manually approved prerequisites

Provision a dedicated **non-public trusted controller host** and a root-only
Ed25519 signing private PEM + separately approved DER SPKI SHA256 fingerprint.
The same public SPKI must be installed on the FI node in
`controller-access.spki`, mode 0600, after independent fingerprint review.
A separate controller-enrollment SSH key must be accepted by the FI forced
command, and its FI host key independently pinned in known_hosts. Neither
the signing private key nor the SSH private key belongs in GitHub Actions,
the public web application, or LLM/agent context.

Apply and verify PostgreSQL enrollment migrations 0128/0129, then create
a `vpn_node_enrollment_inventory` entry in the `approved` state
following the pre-existing **planned → approved** DB transition and separate
operator review of node_id, hostname and public SPKI. The program never
adds or approves this inventory entry itself.

After approval, on the trusted controller only:

```text
MNEBYVPN_ENV=production
MNEBYVPN_FI_ENROLLMENT=enabled
DATABASE_URL=<RESTRICTED_CANONICAL_POSTGRES_URL>
AWG_CONTROLLER_SIGNING_KEY_FILE=<ROOT_ONLY_ED25519_SIGNER_PEM_PATH>
AWG_CONTROLLER_PUBLIC_SHA256=<INDEPENDENT_PUBLIC_SPKI_SHA256>
FI_ENROLL_SSH_KEY_FILE=<DEDICATED_ROOT_ONLY_SSH_PRIVATE_KEY_PATH>
FI_ENROLL_KNOWN_HOSTS_FILE=<PINNED_ROOT_ONLY_KNOWN_HOSTS_PATH>
FI_ENROLL_NODE_PUBLIC_SPKI_FILE=<INDEPENDENT_FI_NODE_PUBLIC_DER_PATH>
```

Use `npm run enroll:fi-controller` **exactly once**; it reports
`FI_ENROLLMENT=testing;SUBSCRIBER_PUBLICATION=false` only upon the
confirmed transaction. These values are configuration names, not values
to paste into GitHub. No credentials are invented or logged.

## What still blocks real customer connections

Successful enrollment is NOT evidence for AWG hard-expiry/revoke E2E,
mobile reachability, per-subscriber grant delivery, verified egress country,
personal DNS wildcard TLS/auth, or SNI proxy policy and external probes.
AWG publishing, `/sub` changes, DNS personalization and production proxy
listeners remain separately gated and disabled. Previous FI transport-only
E2E proof does not replace a real signed client grant/revoke test.

See the server-side instructions in
[Nodekit FI_TRUSTED_ENROLLMENT](https://github.com/grunvald91/telegram-proxy-infra/blob/main/nodekit/FI_TRUSTED_ENROLLMENT.md).
