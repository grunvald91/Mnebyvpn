-- A new bundle request must never silently fall back to a VPN-only trial.
-- Snapshot missed historical verified-email accounts once, without reopening
-- old grants or collecting any new browser/device identifiers.
BEGIN;
ALTER TABLE public.website_vpn_trial_requests
 ADD COLUMN requested_product text
 CHECK(requested_product IS NULL OR requested_product='bundle');

-- Keep newly discovered accounts dormant until the bundle is explicitly
-- enabled and the updated recovery worker is running. Older workers only
-- claim finite due times, so a rolling deploy cannot grant them VPN instead.
INSERT INTO public.website_vpn_trial_requests
 (account_id,device_hash,request_source,requested_product,next_attempt_at)
SELECT a.id,NULL,'LEGACY_EMAIL','bundle','infinity'::timestamptz
FROM public.accounts a
WHERE a.email_address IS NOT NULL
 AND a.created_at<=transaction_timestamp()
 AND NOT EXISTS(SELECT 1 FROM public.web_review_login r WHERE r.account_id=a.id OR r.email=a.email_address)
 AND NOT EXISTS(SELECT 1 FROM public.trial_grants t WHERE t.account_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM public.entitlements e WHERE e.account_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.account_id=a.id AND o.state IN ('PAID','TRIAL','REFUNDED'))
 AND NOT EXISTS(SELECT 1 FROM public.trial_device_claims d WHERE d.account_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM public.website_vpn_trial_requests q WHERE q.account_id=a.id)
ON CONFLICT(account_id) DO NOTHING;
COMMIT;
