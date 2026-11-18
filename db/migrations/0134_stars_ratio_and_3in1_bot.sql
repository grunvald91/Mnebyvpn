-- Proportional integer Telegram Stars pricing for all 3-in-1 RUB catalog tiers.
-- Preserves 0008 pricing_drafts and 0124 personal_dns_*_stars contract rows.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.billing_plans') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM billing_plans WHERE id IN ('vpn_15d_1device', 'smart_dns_15d_rub', 'bundle_15d_3device')
     ) THEN
    RAISE EXCEPTION 'Migration 0132_yookassa_and_3in1_catalog must be installed before 0133';
  END IF;
END $$;

UPDATE billing_plans AS b
SET stars = v.stars
FROM (
  VALUES
    ('vpn_15d_1device', 60::bigint),
    ('vpn_30d_1device', 90::bigint),
    ('vpn_60d_1device', 150::bigint),
    ('vpn_90d_1device', 210::bigint),
    ('smart_dns_15d_rub', 100::bigint),
    ('smart_dns_30d_rub', 200::bigint),
    ('smart_dns_60d_rub', 400::bigint),
    ('smart_dns_90d_rub', 500::bigint),
    ('bundle_15d_3device', 170::bigint),
    ('bundle_30d_3device', 280::bigint),
    ('bundle_60d_3device', 500::bigint),
    ('bundle_90d_3device', 670::bigint)
) AS v(id, stars)
WHERE b.id = v.id
  AND b.enabled = true;

DO $$
DECLARE
  matched int;
BEGIN
  SELECT count(*)::int INTO matched
  FROM (
    VALUES
      ('vpn_15d_1device', 8900::bigint, 60::bigint),
      ('vpn_30d_1device', 14900::bigint, 90::bigint),
      ('vpn_60d_1device', 26900::bigint, 150::bigint),
      ('vpn_90d_1device', 36900::bigint, 210::bigint),
      ('smart_dns_15d_rub', 14900::bigint, 100::bigint),
      ('smart_dns_30d_rub', 24900::bigint, 200::bigint),
      ('smart_dns_60d_rub', 44900::bigint, 400::bigint),
      ('smart_dns_90d_rub', 59900::bigint, 500::bigint),
      ('bundle_15d_3device', 24900::bigint, 170::bigint),
      ('bundle_30d_3device', 39900::bigint, 280::bigint),
      ('bundle_60d_3device', 69900::bigint, 500::bigint),
      ('bundle_90d_3device', 94900::bigint, 670::bigint)
  ) AS expected(id, rub_minor, stars)
  JOIN billing_plans b
    ON b.id = expected.id
   AND b.enabled = true
   AND b.rub_minor = expected.rub_minor
   AND b.stars = expected.stars
   AND b.stars > 0;
  IF matched <> 12 THEN
    RAISE EXCEPTION 'Expected 12 catalog plans with RUB and integer Stars prices, matched %', matched;
  END IF;
END $$;

COMMIT;
