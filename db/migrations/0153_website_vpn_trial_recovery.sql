-- Website VPN trial recovery; only explicitly requested authenticated trials.
BEGIN;
CREATE TABLE website_vpn_trial_requests (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  device_hash text NOT NULL CHECK(device_hash ~ '^[a-f0-9]{64}$'),
  invite_token text CHECK(invite_token IS NULL OR invite_token ~ '^[A-Za-z0-9_-]{16,24}$'),
  order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','WAITING','SENT','REJECTED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  CHECK(status NOT IN ('WAITING','SENT') OR order_id IS NOT NULL)
);
CREATE INDEX website_vpn_trial_requests_due_idx ON website_vpn_trial_requests(next_attempt_at)
 WHERE status IN ('PENDING','WAITING');
REVOKE ALL ON website_vpn_trial_requests FROM PUBLIC;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_pay') THEN
  -- The website role already locks accounts and creates orders/outbox.
  -- Complete the narrowly scoped missing trial transaction privileges.
  GRANT SELECT ON public.trial_grants,public.trial_device_claims TO mnebyvpn_site_pay;
  GRANT INSERT(telegram_user_id,account_id,order_id,product,invite_token)
    ON public.trial_grants TO mnebyvpn_site_pay;
  GRANT INSERT(device_hash,account_id) ON public.trial_device_claims TO mnebyvpn_site_pay;
  GRANT SELECT,INSERT,UPDATE ON public.website_vpn_trial_requests TO mnebyvpn_site_pay;
 END IF;
END;
$$;
COMMIT;
