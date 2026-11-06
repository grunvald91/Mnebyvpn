-- Phase 8 SQL constraints on a disposable PostgreSQL, rolled back.
BEGIN;
DO $$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM trial_offers;
 IF n<>3 THEN RAISE EXCEPTION 'Expected configurable VPN, DNS, bundle trials: %',n; END IF;
 IF EXISTS(SELECT 1 FROM trial_offers WHERE enabled) THEN
  RAISE EXCEPTION 'Trial must remain disabled before network provisioning';
 END IF;
 BEGIN
  UPDATE trial_offers SET enabled=true WHERE product='smart_dns';
  RAISE EXCEPTION 'Smart DNS trial enabled without quota';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns
  WHERE table_name='trial_grants' AND column_name='telegram_user_id') THEN
  RAISE EXCEPTION 'No trial identity uniqueness';
 END IF;
END $$;
ROLLBACK;
