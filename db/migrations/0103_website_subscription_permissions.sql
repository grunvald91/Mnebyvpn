-- Existing deployments keep their reader read-only. Minting a browser's
-- subscription link uses the authenticated canonical connection instead.
-- Fresh installations receive the same grants from the infra role setup.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
    GRANT SELECT ON public.provisioning_state,public.vpn_subscription_links TO mnebyvpn_site_auth;
    GRANT INSERT(token_sha256,entitlement_id) ON public.vpn_subscription_links TO mnebyvpn_site_auth;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_pay') THEN
    GRANT SELECT ON public.trial_grants TO mnebyvpn_site_pay;
  END IF;
END;
$$;
COMMIT;
