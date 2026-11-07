-- Owner-requested Telegram Stars VPN prices, 2026-11-06.
-- Reference: 100 Stars cost RUB 209 in the Russian App Store (2026-10-30).
-- One-off XTR prices reflect approximately 18% markup compared with RUB offers.
-- Rates vary by storefront; THESE integer XTR amounts are fixed catalog prices.
-- Existing orders preserve the immutable amount/currency in their order snapshots.
BEGIN;

UPDATE billing_plans SET stars=CASE id
    WHEN 'vpn_15d_1device' THEN 34
    WHEN 'vpn_30d_1device' THEN 56
    WHEN 'vpn_60d_1device' THEN 112
    WHEN 'vpn_90d_1device' THEN 141
    ELSE stars END
 WHERE id IN ('vpn_15d_1device','vpn_30d_1device',
              'vpn_60d_1device','vpn_90d_1device')
   AND product='vpn' AND enabled=true AND device_limit=1;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM billing_plans
   WHERE (id='vpn_15d_1device' AND stars=34 AND rub_minor=6000 AND duration_seconds=15*86400)
      OR (id='vpn_30d_1device' AND stars=56 AND rub_minor=9900 AND duration_seconds=30*86400)
      OR (id='vpn_60d_1device' AND stars=112 AND rub_minor=19900 AND duration_seconds=60*86400)
      OR (id='vpn_90d_1device' AND stars=141 AND rub_minor=24900 AND duration_seconds=90*86400);
  IF n<>4 THEN
    RAISE EXCEPTION 'Approved VPN RUB and XTR price catalog is incomplete';
  END IF;
END $$;

UPDATE pricing_drafts AS p SET stars=x.stars
FROM (VALUES
  (15*86400::bigint,34::bigint),
  (30*86400::bigint,56::bigint),
  (60*86400::bigint,112::bigint),
  (90*86400::bigint,141::bigint)
) AS x(duration_seconds,stars)
WHERE p.product='vpn' AND p.duration_seconds=x.duration_seconds;

COMMIT;
