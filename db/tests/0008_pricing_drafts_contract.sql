BEGIN;
DO $$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM pricing_drafts;
 IF n<>8 THEN RAISE EXCEPTION 'Expected eight configurable term slots, got %',n; END IF;
 IF EXISTS(SELECT 1 FROM pricing_drafts WHERE stars IS NOT NULL OR rub_minor IS NOT NULL) THEN
  RAISE EXCEPTION 'Unapproved paid prices must remain NULL';
 END IF;
 IF EXISTS(SELECT 1 FROM billing_plans WHERE id LIKE 'draft_%') THEN
  RAISE EXCEPTION 'Drafts must not be available for purchase';
 END IF;
END $$;
ROLLBACK;
