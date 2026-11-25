-- One-time remediation of missed free VPN access for existing verified email accounts.
-- Snapshot all accounts existing when this one-time migration starts.
-- A verified account is the canonical result of successful email OTP verification.
-- Never infer verification from an unconsumed OTP row, never invent a device hash.
BEGIN;
ALTER TABLE website_vpn_trial_requests
 ADD COLUMN request_source text NOT NULL DEFAULT 'WEBSITE',
 ALTER COLUMN device_hash DROP NOT NULL;
ALTER TABLE website_vpn_trial_requests
 ADD CONSTRAINT website_trial_request_source_check CHECK (
  (request_source='WEBSITE' AND device_hash IS NOT NULL)
  OR (request_source='LEGACY_EMAIL' AND device_hash IS NULL AND invite_token IS NULL)
 );
-- Backfill only historical accounts with no existing access or trial claim.
-- An unpaid abandoned checkout is not an issued subscription.
INSERT INTO website_vpn_trial_requests(account_id,device_hash,request_source)
SELECT a.id,NULL,'LEGACY_EMAIL'
FROM accounts a
WHERE a.email_address IS NOT NULL
 AND a.created_at <= transaction_timestamp()
 AND NOT EXISTS(SELECT 1 FROM web_review_login r WHERE r.account_id=a.id OR r.email=a.email_address)
 AND NOT EXISTS(SELECT 1 FROM trial_grants t WHERE t.account_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM entitlements e WHERE e.account_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.account_id=a.id AND o.state IN ('PAID','TRIAL','REFUNDED'))
 AND NOT EXISTS(SELECT 1 FROM trial_device_claims d WHERE d.account_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM website_vpn_trial_requests q WHERE q.account_id=a.id)
ON CONFLICT(account_id) DO NOTHING;
COMMIT;
