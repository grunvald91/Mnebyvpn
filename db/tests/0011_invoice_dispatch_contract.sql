BEGIN;
DO $$
DECLARE
  constraint_exists boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM pg_constraint
  WHERE conrelid='telegram_invoice_dispatch'::regclass
   AND contype='p') INTO constraint_exists;
 IF NOT constraint_exists THEN RAISE EXCEPTION 'No unique dispatch per order'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns
  WHERE table_name='telegram_invoice_dispatch' AND column_name='state') THEN
  RAISE EXCEPTION 'No durable delivery state'; END IF;
END $$;
ROLLBACK;
