BEGIN;
DO $$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM pg_constraint
  WHERE conrelid='account_product_slot'::regclass AND contype='p';
 IF n<>1 THEN RAISE EXCEPTION 'missing stable active product slot'; END IF;
 SELECT count(*) INTO n FROM pg_constraint
  WHERE conrelid='order_entitlement_credits'::regclass AND contype='p';
 IF n<>1 THEN RAISE EXCEPTION 'missing per-order refundable access ledger'; END IF;
 SELECT count(*) INTO n FROM pg_constraint
  WHERE conrelid='payment_incidents'::regclass AND contype='u';
 IF n<1 THEN RAISE EXCEPTION 'missing unmatched charge dedup constraint'; END IF;
 SELECT count(*) INTO n FROM information_schema.columns
  WHERE table_name='trial_offers' AND column_name='max_daily_grants';
 IF n<>1 THEN RAISE EXCEPTION 'missing bounded trial cap'; END IF;
END $$;
ROLLBACK;
