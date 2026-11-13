-- 200 Stars is approved, but the offer MUST NOT be chargeable until
-- the public DNS-over-TLS data plane and issuing flow are accepted.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pricing_drafts
    WHERE product='smart_dns' AND duration_seconds=2592000
      AND title='Smart DNS · 30 дней · персональный адрес'
      AND stars=200 AND rub_minor=20000 AND dns_quota_bytes IS NULL
  ) THEN RAISE EXCEPTION 'Approved Smart DNS price not saved exactly'; END IF;
  IF EXISTS(
    SELECT 1 FROM billing_plans
    WHERE product='smart_dns' AND id='personal_dns_30d_stars' AND enabled
  ) THEN RAISE EXCEPTION 'Premature live Smart DNS Stars checkout'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE proname='issue_personal_dns_credential'
  ) THEN RAISE EXCEPTION 'Personal DoT credential issuance schema missing'; END IF;
END $$;
ROLLBACK;
