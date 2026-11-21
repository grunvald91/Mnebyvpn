-- Staged owner-only three-device VPN seat inventory.
-- IMPORTANT: a seat is NOT an AWG peer, NOT a verified physical device,
-- and NOT a grant. No public or worker enrolment is enabled by this migration.
-- Existing VLESS and AWG allocations and all owner bearer URLs stay untouched.
BEGIN;
CREATE TABLE owner_vpn_device_seats (
  entitlement_id uuid NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  slot_number smallint NOT NULL CHECK (slot_number BETWEEN 1 AND 3),
  peer_public_key text UNIQUE
    CHECK (peer_public_key IS NULL OR peer_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  state text NOT NULL DEFAULT 'EMPTY'
    CHECK (state IN ('EMPTY','REQUESTED','REVOKED')),
  registered_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (entitlement_id,slot_number),
  CHECK (
    (state='EMPTY' AND peer_public_key IS NULL
     AND registered_at IS NULL AND revoked_at IS NULL) OR
    (state='REQUESTED' AND peer_public_key IS NOT NULL
     AND registered_at IS NOT NULL AND revoked_at IS NULL) OR
    (state='REVOKED' AND revoked_at IS NOT NULL)
  )
);
REVOKE ALL ON owner_vpn_device_seats FROM PUBLIC;

-- Source of truth is the original owner-attested manual bundle and its
-- immutable order_terms.device_limit=3. Never allocate seats to trial,
-- website, Stars, 1-device or refunded plans.
CREATE FUNCTION public.owner_vpn_initialize_device_seats()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $seat$
BEGIN
  IF NEW.product='vpn' AND EXISTS(
    SELECT 1 FROM public.manual_sales m
    JOIN public.orders o ON o.id=m.order_id
    JOIN public.order_terms t ON t.order_id=o.id
    WHERE o.id=NEW.source_order_id
      AND o.account_id=NEW.account_id
      AND o.provider='manual_sale' AND o.product='bundle' AND o.state='PAID'
      AND t.plan_id='bundle_30d_3device' AND t.device_limit=3
  ) THEN
    INSERT INTO public.owner_vpn_device_seats(entitlement_id,slot_number)
    SELECT NEW.id,s.num FROM generate_series(1,3) AS s(num)
    WHERE TRUE ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$seat$;
REVOKE ALL ON FUNCTION public.owner_vpn_initialize_device_seats() FROM PUBLIC;
CREATE TRIGGER owner_vpn_prepare_three_seats
  AFTER INSERT ON entitlements
  FOR EACH ROW EXECUTE FUNCTION public.owner_vpn_initialize_device_seats();

-- Idempotent backfill of historical manual-sale rows after 0141. Never
-- overwrite, rotate or reassign existing peer keys.
INSERT INTO public.owner_vpn_device_seats(entitlement_id,slot_number)
SELECT e.id,s.num
FROM public.manual_sales m
JOIN public.orders o ON o.id=m.order_id
JOIN public.order_terms t ON t.order_id=o.id
JOIN public.entitlements e ON e.source_order_id=o.id
  AND e.account_id=o.account_id AND e.product='vpn'
CROSS JOIN generate_series(1,3) s(num)
WHERE o.provider='manual_sale' AND o.product='bundle' AND o.state='PAID'
  AND t.plan_id='bundle_30d_3device' AND t.device_limit=3
ON CONFLICT DO NOTHING;

-- Only private owner bot can inspect the staged inventory. No WRITE grant:
-- a separate vetted per-device authorization/revocation pipeline is required
-- before registration. In particular, public website cannot claim seats.
DO $seat_grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='mnebyvpn_bot') THEN
    GRANT SELECT ON public.owner_vpn_device_seats TO mnebyvpn_bot;
  END IF;
END;
$seat_grant$;
COMMIT;
