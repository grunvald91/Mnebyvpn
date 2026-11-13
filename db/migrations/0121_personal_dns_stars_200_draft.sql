-- Owner-approved pilot offer: 200 Telegram Stars for 30 x 24 hours.
-- Commercially NOT published. Payment provider integration already exists,
-- but DoT ingress, public wildcard TLS and automatic activation are not ready.
-- This modifies a pricing DRAFT only, never billing_plans.enabled.
-- Product has 1,000,000 settled premium DNS queries per 30-day window;
-- this is not traffic bytes and must not be put in dns_quota_bytes.
BEGIN;
UPDATE pricing_drafts
   SET title='Smart DNS · 30 дней · персональный адрес',
       stars=200,
       rub_minor=20000,
       dns_quota_bytes=NULL
 WHERE product='smart_dns' AND duration_seconds=30*86400;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pricing_drafts
   WHERE product='smart_dns' AND duration_seconds=2592000
     AND stars=200 AND rub_minor=20000 AND dns_quota_bytes IS NULL;
  IF n<>1 THEN RAISE EXCEPTION 'Personal Smart DNS draft price or quota metric mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM billing_plans
    WHERE product='smart_dns' AND id='personal_dns_30d_stars' AND enabled)
  THEN RAISE EXCEPTION 'Personal DNS must remain unlisted until DoT ingress verified'; END IF;
END $$;
COMMIT;
