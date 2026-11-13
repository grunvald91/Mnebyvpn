BEGIN;
DO $$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM pricing_drafts;
 IF n<>8 THEN RAISE EXCEPTION 'Expected eight configurable term slots, got %',n; END IF;
 -- 2026-11-13: One Smart DNS offer is owner-approved at 200 Stars
 -- for 30 days, but ONLY in pricing_drafts. No live checkout is enabled.
 -- All other DNS/bundle price slots remain unset.
 IF EXISTS(SELECT 1 FROM pricing_drafts
    WHERE product<>'vpn' AND (stars IS NOT NULL OR rub_minor IS NOT NULL)
      AND NOT (product='smart_dns' AND duration_seconds=30*86400
        AND stars=200 AND rub_minor=20000 AND dns_quota_bytes IS NULL)) THEN
  RAISE EXCEPTION 'Unapproved Smart DNS price in another draft term';
 END IF;
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
