BEGIN;
DO $$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM pricing_drafts;
 IF n<>9 THEN RAISE EXCEPTION 'Expected nine configurable term slots, got %',n; END IF;
 -- Four owner-approved Smart DNS Stars offers are drafts until the live gates pass.
 IF EXISTS(SELECT 1 FROM pricing_drafts d WHERE d.product<>'vpn'
     AND (d.stars IS NOT NULL OR d.rub_minor IS NOT NULL)
     AND NOT EXISTS(
       SELECT 1 FROM (VALUES (14::bigint,100::bigint),
         (30::bigint,200::bigint),(60::bigint,400::bigint),
         (90::bigint,500::bigint)) expected(days,stars)
       WHERE d.product='smart_dns'
         AND d.duration_seconds=expected.days*86400
         AND d.stars=expected.stars
         AND d.rub_minor IS NULL
         AND d.dns_quota_bytes IS NULL
         AND d.dns_quota_queries_per_30d=1000000
     )) THEN RAISE EXCEPTION 'Unapproved Smart DNS price in another draft term'; END IF;
 IF EXISTS(SELECT 1 FROM pricing_drafts WHERE product='vpn' AND
   (duration_seconds,rub_minor) NOT IN (
     (15*86400::bigint,6000::bigint),(30*86400::bigint,9900::bigint),
     (60*86400::bigint,19900::bigint),(90*86400::bigint,24900::bigint)
   )) THEN
  RAISE EXCEPTION 'VPN draft price must match the approved RUB matrix';
 END IF;
 IF EXISTS(SELECT 1 FROM pricing_drafts WHERE product='vpn' AND
   (duration_seconds,stars) NOT IN (
     (15*86400::bigint,40::bigint),(30*86400::bigint,60::bigint),
     (60*86400::bigint,110::bigint),(90*86400::bigint,140::bigint)
   )) THEN
  RAISE EXCEPTION 'VPN XTR draft price must match approved fixed Stars matrix';
 END IF;
 IF EXISTS(SELECT 1 FROM billing_plans WHERE id LIKE 'draft_%') THEN
  RAISE EXCEPTION 'Drafts must not be available for purchase';
 END IF;
END $$;
ROLLBACK;
