-- Website-only guest VPN trials: no Telegram account required.
-- Guest browser holds a random HttpOnly cookie; only its digest is stored.
-- Trial clock is still started by acknowledge_provisioning() after real node ACK.
BEGIN;

CREATE TABLE web_guest_claims (
  token_sha256 text PRIMARY KEY CHECK(token_sha256 ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Telegram trials retain their existing unique actor key; a website trial
-- instead binds one grant to a guest claim and never invents a Telegram ID.
ALTER TABLE trial_grants DROP CONSTRAINT trial_grants_pkey;
ALTER TABLE trial_grants ALTER COLUMN telegram_user_id DROP NOT NULL;
ALTER TABLE trial_grants
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN guest_claim_hash text UNIQUE REFERENCES web_guest_claims(token_sha256),
  ADD CONSTRAINT trial_grants_pkey PRIMARY KEY(id),
  ADD CONSTRAINT trial_grants_telegram_unique UNIQUE(telegram_user_id),
  ADD CONSTRAINT trial_grants_exactly_one_owner CHECK (
    (telegram_user_id IS NOT NULL) <> (guest_claim_hash IS NOT NULL)
  );
REVOKE ALL ON web_guest_claims FROM PUBLIC;
COMMIT;
