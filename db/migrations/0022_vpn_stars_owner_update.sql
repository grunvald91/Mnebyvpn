-- Owner approved final Telegram Stars price matrix on 2026-11-07.
-- Published offers only; completed orders retain their original immutable amount.
BEGIN;
UPDATE billing_plans
 SET stars = CASE id
  WHEN 'vpn_15d_1device' THEN 40
  WHEN 'vpn_30d_1device' THEN 60
  WHEN 'vpn_60d_1device' THEN 110
  WHEN 'vpn_90d_1device' THEN 140
 END
 WHERE id IN ('vpn_15d_1device','vpn_30d_1device','vpn_60d_1device','vpn_90d_1device')
 AND product='vpn' AND enabled AND device_limit=1;
DO $$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM billing_plans
 WHERE (id='vpn_15d_1device' AND stars=40 AND rub_minor=6000 AND duration_seconds=15*86400)
    OR (id='vpn_30d_1device' AND stars=60 AND rub_minor=9900 AND duration_seconds=30*86400)
    OR (id='vpn_60d_1device' AND stars=110 AND rub_minor=19900 AND duration_seconds=60*86400)
    OR (id='vpn_90d_1device' AND stars=140 AND rub_minor=24900 AND duration_seconds=90*86400);
 IF n<>4 THEN RAISE EXCEPTION 'Incomplete approved VPN XTR/RUB offer catalog'; END IF;
END $$;
UPDATE pricing_drafts p SET stars=v.stars
 FROM (VALUES
  (15*86400::bigint,40::bigint),
  (30*86400::bigint,60::bigint),
  (60*86400::bigint,110::bigint),
  (90*86400::bigint,140::bigint)
 ) AS v(duration_seconds,stars)
 WHERE p.product='vpn' AND p.duration_seconds=v.duration_seconds;
COMMIT;
