-- Approved by MNEBYVPN owner 2026-11-06: four VPN packages for ONE device.
-- RUB prices are kopecks, not Stars. No invented XTR exchange rate.
-- Orders already issued preserve their immutable order_terms snapshots.
BEGIN;
ALTER TABLE billing_plans
  ADD COLUMN device_limit smallint NOT NULL DEFAULT 1
    CHECK (device_limit BETWEEN 1 AND 16);
ALTER TABLE order_terms
  ADD COLUMN device_limit smallint NOT NULL DEFAULT 1
    CHECK (device_limit BETWEEN 1 AND 16);

-- Never let an existing, unrelated product ID be repurposed for VPN.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM billing_plans
      WHERE id IN ('vpn_15d_1device','vpn_30d_1device',
                   'vpn_60d_1device','vpn_90d_1device')
        AND product <> 'vpn'
  ) THEN
    RAISE EXCEPTION 'Conflicting owner VPN price plan identifier';
  END IF;
END $$;

-- Remove conflicting older offers from public purchasing; old paid orders
-- and entitlements continue to reference their original plan terms.
UPDATE billing_plans SET enabled=false
 WHERE product='vpn' AND duration_seconds IN
   (15*86400,30*86400,60*86400,90*86400)
   AND id NOT IN ('vpn_15d_1device','vpn_30d_1device',
                  'vpn_60d_1device','vpn_90d_1device');

INSERT INTO billing_plans(
  id,product,title,duration_seconds,dns_quota_bytes,rub_minor,stars,enabled,device_limit
) VALUES
  ('vpn_15d_1device','vpn','VPN · 15 дней · 1 устройство',15*86400,NULL,6000,NULL,true,1),
  ('vpn_30d_1device','vpn','VPN · 30 дней · 1 устройство',30*86400,NULL,9900,NULL,true,1),
  ('vpn_60d_1device','vpn','VPN · 60 дней · 1 устройство',60*86400,NULL,19900,NULL,true,1),
  ('vpn_90d_1device','vpn','VPN · 90 дней · 1 устройство',90*86400,NULL,24900,NULL,true,1)
ON CONFLICT(id) DO UPDATE SET
  title=EXCLUDED.title,
  duration_seconds=EXCLUDED.duration_seconds,
  rub_minor=EXCLUDED.rub_minor,
  dns_quota_bytes=EXCLUDED.dns_quota_bytes,
  device_limit=1,
  enabled=true;
-- Preserve an independently approved Stars price if explicitly configured
-- in the same canonical plan; never derive XTR from the RUB values above.

UPDATE pricing_drafts AS p SET
  rub_minor=x.rub_minor,
  title=x.title
FROM (VALUES
  (15*86400::bigint,6000::bigint,'VPN · 15 дней · 1 устройство'),
  (30*86400::bigint,9900::bigint,'VPN · 30 дней · 1 устройство'),
  (60*86400::bigint,19900::bigint,'VPN · 60 дней · 1 устройство'),
  (90*86400::bigint,24900::bigint,'VPN · 90 дней · 1 устройство')
) AS x(duration_seconds,rub_minor,title)
WHERE p.product='vpn' AND p.duration_seconds=x.duration_seconds;

COMMIT;
