-- Allow website's narrowly scoped billing role to issue personal invite codes.
-- This role is already responsible for website order referrals and may need
-- direct token insertion for email-only accounts. No access to site auth roles.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_pay') THEN
    GRANT SELECT ON public.referral_invites TO mnebyvpn_site_pay;
    GRANT INSERT(token,referrer_account_id,plan_id) ON public.referral_invites TO mnebyvpn_site_pay;
  END IF;
END;
$$;
COMMIT;
