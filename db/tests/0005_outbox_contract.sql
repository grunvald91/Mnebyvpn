-- Requires 0001 through 0005. All test rows rollback.
BEGIN;
DO $$
DECLARE
  v integer;
BEGIN
  SELECT count(*) INTO v FROM information_schema.columns
    WHERE table_schema='public' AND table_name='reconcile_outbox'
      AND column_name IN ('next_attempt_at','last_error_code');
  IF v <> 2 THEN RAISE EXCEPTION 'Outbox retries columns absent'; END IF;
END
$$;
ROLLBACK;
