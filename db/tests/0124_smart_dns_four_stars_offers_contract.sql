-- The new XTR tariff matrix is prepared, not silently activated.
BEGIN;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM (VALUES
    ('personal_dns_14d_stars',14::bigint,100::bigint),
    ('personal_dns_30d_stars',30::bigint,200::bigint),
    ('personal_dns_60d_stars',60::bigint,400::bigint),
    ('personal_dns_90d_stars',90::bigint,500::bigint)
  ) o(id,days,price)
  JOIN billing_plans p ON p.id=o.id AND p.product='smart_dns'
   AND p.duration_seconds=o.days*86400 AND p.stars=o.price
   AND p.dns_quota_bytes IS NULL AND p.dns_quota_queries_per_30d=1000000;
  IF n<>4 THEN RAISE EXCEPTION 'Approved DNS tariffs missing: %',n; END IF;
  SELECT count(*) INTO n FROM billing_plans
  WHERE id IN ('personal_dns_14d_stars','personal_dns_60d_stars',
    'personal_dns_90d_stars') AND enabled;
  IF n<>0 THEN RAISE EXCEPTION 'New DNS tariffs enabled without E2E'; END IF;
END $$;
ROLLBACK;
