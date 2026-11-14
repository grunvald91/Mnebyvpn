-- Owner-approved Smart DNS Stars matrix (2026-11-14).
-- 14/30/60/90 days at 100/200/400/500 XTR, one million questions per
-- fixed 30-day meter window (or until earlier expiry). Never bytes.
-- This migration PREPARES offers but does NOT turn on paid checkout.
-- Publication requires verified public DoT/853 + Telegram E2E and rollback.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.billing_plans') IS NULL OR
     NOT EXISTS(SELECT 1 FROM information_schema.columns
       WHERE table_name='billing_plans' AND column_name='dns_quota_queries_per_30d')
  THEN RAISE EXCEPTION 'Native query-meter migration 0122 must be installed first'; END IF;
  IF EXISTS(SELECT 1 FROM billing_plans WHERE id IN
      ('personal_dns_14d_stars','personal_dns_30d_stars',
       'personal_dns_60d_stars','personal_dns_90d_stars')
       AND product<>'smart_dns')
  THEN RAISE EXCEPTION 'Refusing to overwrite non-DNS published plan'; END IF;
END $$;

WITH approved(id,days,stars) AS (
  VALUES
   ('personal_dns_14d_stars',14::bigint,100::bigint),
   ('personal_dns_30d_stars',30::bigint,200::bigint),
   ('personal_dns_60d_stars',60::bigint,400::bigint),
   ('personal_dns_90d_stars',90::bigint,500::bigint)
)
INSERT INTO billing_plans(id,product,title,duration_seconds,
  dns_quota_bytes,dns_quota_queries_per_30d,rub_minor,stars,enabled,device_limit)
SELECT id,'smart_dns','Smart DNS · '||days||' дней · персональный адрес',
  days*86400,NULL,1000000,NULL,stars,false,1 FROM approved
ON CONFLICT(id) DO UPDATE SET
  title=EXCLUDED.title,duration_seconds=EXCLUDED.duration_seconds,
  dns_quota_bytes=NULL,dns_quota_queries_per_30d=1000000,
  rub_minor=NULL,stars=EXCLUDED.stars,
  enabled=billing_plans.enabled
WHERE billing_plans.product='smart_dns' AND
  (billing_plans.enabled=false OR
    (billing_plans.stars=EXCLUDED.stars AND
     billing_plans.duration_seconds=EXCLUDED.duration_seconds AND
     billing_plans.dns_quota_bytes IS NULL AND
     billing_plans.dns_quota_queries_per_30d=1000000));

WITH approved(days,stars) AS (
  VALUES (14::bigint,100::bigint),(30,200),(60,400),(90,500)
)
INSERT INTO pricing_drafts(product,duration_seconds,title,
  rub_minor,stars,dns_quota_bytes,dns_quota_queries_per_30d)
SELECT 'smart_dns',days*86400,
  'Smart DNS · '||days||' дней · персональный адрес',
  NULL,stars,NULL,1000000 FROM approved
ON CONFLICT(product,duration_seconds) DO UPDATE SET
  title=EXCLUDED.title,stars=EXCLUDED.stars,rub_minor=NULL,
  dns_quota_bytes=NULL,dns_quota_queries_per_30d=1000000;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM (VALUES
    ('personal_dns_14d_stars',14::bigint,100::bigint),
    ('personal_dns_30d_stars',30::bigint,200::bigint),
    ('personal_dns_60d_stars',60::bigint,400::bigint),
    ('personal_dns_90d_stars',90::bigint,500::bigint)
  ) AS terms(id,days,stars)
  JOIN billing_plans b ON b.id=terms.id
  JOIN pricing_drafts d ON d.product='smart_dns'
    AND d.duration_seconds=terms.days*86400
  WHERE b.product='smart_dns' AND b.stars=terms.stars
    AND b.duration_seconds=terms.days*86400
    AND b.dns_quota_bytes IS NULL AND b.dns_quota_queries_per_30d=1000000
    AND b.rub_minor IS NULL
    AND d.stars=terms.stars AND d.dns_quota_queries_per_30d=1000000
    AND d.dns_quota_bytes IS NULL;
  IF n<>4 THEN RAISE EXCEPTION 'Smart DNS four-offer catalog mismatch: %',n; END IF;
  IF EXISTS(SELECT 1 FROM billing_plans
    WHERE id IN ('personal_dns_14d_stars','personal_dns_60d_stars',
      'personal_dns_90d_stars') AND enabled)
  THEN RAISE EXCEPTION 'New Smart DNS offers must not enable paid checkout automatically'; END IF;
END $$;
COMMIT;
