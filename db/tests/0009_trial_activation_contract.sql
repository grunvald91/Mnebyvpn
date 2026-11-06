BEGIN;
DO $$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM information_schema.columns
  WHERE table_name='trial_grants'
   AND column_name IN ('activated_at','access_expires_at');
 IF n<>2 THEN RAISE EXCEPTION 'Trial activation columns missing'; END IF;
 IF EXISTS(SELECT 1 FROM trial_grants
    WHERE activated_at IS NOT NULL
      AND access_expires_at IS DISTINCT FROM activated_at+interval '24 hours') THEN
   RAISE EXCEPTION 'Trial activation duration inconsistent'; END IF;
END $$;
ROLLBACK;
