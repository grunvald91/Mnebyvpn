-- Site identities are verified provider subjects, not emails or browser cookies.
-- One verified provider account maps to a single internal account.
-- Existing Telegram identity and its trial entitlement remain intact.
BEGIN;
ALTER TABLE accounts ADD COLUMN yandex_user_id text UNIQUE
  CHECK (yandex_user_id IS NULL OR yandex_user_id ~ '^[0-9]{1,32}$');
-- Phase 17 added guest grants. From now on, newly issued site trials must be
-- claimed using an authenticated account; Yandex-only accounts have no TG ID.
-- Retain historical guest grants but never create them from a public endpoint.
ALTER TABLE trial_grants DROP CONSTRAINT trial_grants_exactly_one_owner;
ALTER TABLE trial_grants ADD CONSTRAINT trial_grants_at_most_one_legacy_owner
  CHECK (telegram_user_id IS NULL OR guest_claim_hash IS NULL);
-- Unique(account_id) already enforces one lifetime trial per internal account.
REVOKE ALL ON accounts FROM PUBLIC;
COMMIT;
