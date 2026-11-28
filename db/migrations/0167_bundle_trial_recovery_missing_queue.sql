-- Recover missed verified-email accounts and canonical bundle grants which
-- have no ready-notice queue row. Never renew an existing entitlement.
BEGIN;
INSERT INTO public.website_vpn_trial_requests
 (account_id,device_hash,request_source,requested_product,next_attempt_at)
SELECT a.id,NULL,'LEGACY_EMAIL','bundle','infinity'::timestamptz
FROM public.accounts a
WHERE a.email_address IS NOT NULL
 AND a.created_at<=transaction_timestamp()
 AND NOT EXISTS(SELECT 1 FROM public.web_review_login r WHERE r.account_id=a.id OR r.email=a.email_address)
 AND NOT EXISTS(SELECT 1 FROM public.website_vpn_trial_requests q WHERE q.account_id=a.id)
 AND (
   (
     NOT EXISTS(SELECT 1 FROM public.trial_grants t WHERE t.account_id=a.id)
     AND NOT EXISTS(SELECT 1 FROM public.entitlements e WHERE e.account_id=a.id)
     AND NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.account_id=a.id AND o.state IN ('PAID','TRIAL','REFUNDED'))
     AND NOT EXISTS(SELECT 1 FROM public.trial_device_claims d WHERE d.account_id=a.id)
   ) OR EXISTS(
     SELECT 1 FROM public.trial_grants t
     JOIN public.orders o ON o.id=t.order_id AND o.account_id=t.account_id
     WHERE t.account_id=a.id AND t.product='bundle' AND o.product='bundle'
       AND o.provider='internal_trial' AND o.state='TRIAL' AND o.amount_minor=0
       AND (t.activated_at IS NULL OR (t.access_expires_at>transaction_timestamp()
         AND t.access_expires_at=t.activated_at+interval '24 hours'))
   )
 )
ON CONFLICT(account_id) DO NOTHING;
COMMIT;
