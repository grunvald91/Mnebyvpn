BEGIN;
CREATE TABLE website_vpn_trial_recovery_invites (
 account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
 status text NOT NULL CHECK(status IN ('SENDING','SENT','FAILED')),
 attempt_id uuid NOT NULL,
 attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 sent_at timestamptz,
 CHECK((status='SENT')=(sent_at IS NOT NULL))
);
REVOKE ALL ON website_vpn_trial_recovery_invites FROM PUBLIC;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_pay') THEN
  GRANT SELECT,INSERT,UPDATE ON website_vpn_trial_recovery_invites TO mnebyvpn_site_pay;
 END IF;
END;
$$;
COMMIT;
