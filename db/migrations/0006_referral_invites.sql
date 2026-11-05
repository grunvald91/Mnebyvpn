-- Phase 7: public forwardable referral cards, no rewards or payouts implied.
BEGIN;
CREATE TABLE referral_invites (
 token text PRIMARY KEY CHECK(token ~ '^[A-Za-z0-9_-]{16,24}$'),
 referrer_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
 plan_id text NOT NULL REFERENCES billing_plans(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(referrer_account_id,plan_id)
);
CREATE TABLE order_referrals (
 order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
 invite_token text NOT NULL REFERENCES referral_invites(token) ON DELETE RESTRICT,
 referrer_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_referrals_owner_idx
 ON order_referrals(referrer_account_id,recorded_at);
REVOKE ALL ON referral_invites FROM PUBLIC;
REVOKE ALL ON order_referrals FROM PUBLIC;
COMMIT;
