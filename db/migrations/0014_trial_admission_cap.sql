-- Phase 14: bounded trial exposure across freshly created Telegram accounts.
-- Cannot prove a user is unique without external identity verification.
BEGIN;
ALTER TABLE trial_offers ADD COLUMN max_daily_grants integer NOT NULL DEFAULT 30
 CHECK(max_daily_grants BETWEEN 1 AND 1000);
-- trials are still disabled by default in migration 0007
COMMIT;
