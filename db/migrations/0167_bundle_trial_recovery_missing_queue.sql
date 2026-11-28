-- Recover missed verified-email accounts and canonical bundle grants which
-- have no ready-notice queue row. Never renew an existing entitlement.
-- Run with legacy recovery workers drained; see rollout instructions.
BEGIN;
-- Pre-existing unfulfilled legacy recovery rows must not consume the single
-- trial on the old VPN offer while bundle activation is still gated.
UPDATE public.website_vpn_trial_requests q
SET requested_product='bundle',next_attempt_at='infinity'::timestamptz
WHERE q.request_source='LEGACY_EMAIL' AND q.status='PENDING'
  AND q.order_id IS NULL AND q.requested_product IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.trial_grants t WHERE t.account_id=q.account_id);

INSERT INTO public.website_vpn_trial_requests
 (account_id,device_hash,request_source,requested_product,next_attempt_at,status,order_id)
SELECT a.id,NULL,'LEGACY_EMAIL','bundle',
 CASE WHEN existing.order_id IS NULL THEN 'infinity'::timestamptz ELSE clock_timestamp() END,
 CASE WHEN existing.order_id IS NULL THEN 'PENDING' ELSE 'WAITING' END,existing.order_id
FROM public.accounts a
LEFT JOIN LATERAL (
 SELECT t.order_id FROM public.trial_grants t
 JOIN public.orders o ON o.id=t.order_id AND o.account_id=t.account_id
 WHERE t.account_id=a.id AND t.product='bundle' AND o.product='bundle'
   AND o.provider='internal_trial' AND o.state='TRIAL' AND o.amount_minor=0
   AND (t.activated_at IS NULL OR (t.access_expires_at>transaction_timestamp()
     AND t.access_expires_at=t.activated_at+interval '24 hours'))
 LIMIT 1
) existing ON true
WHERE a.email_address IS NOT NULL
 AND a.created_at<=transaction_timestamp()
 AND NOT EXISTS(SELECT 1 FROM public.web_review_login r WHERE r.account_id=a.id OR r.email=a.email_address)
 AND NOT EXISTS(SELECT 1 FROM public.website_vpn_trial_requests q WHERE q.account_id=a.id)
 AND (
   existing.order_id IS NOT NULL OR (
     NOT EXISTS(SELECT 1 FROM public.trial_grants t WHERE t.account_id=a.id)
     AND NOT EXISTS(SELECT 1 FROM public.entitlements e WHERE e.account_id=a.id)
     AND NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.account_id=a.id AND o.state IN ('PAID','TRIAL','REFUNDED'))
     AND NOT EXISTS(SELECT 1 FROM public.trial_device_claims d WHERE d.account_id=a.id)
   )
 )
ON CONFLICT(account_id) DO NOTHING;
COMMIT;
