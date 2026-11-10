-- Owner SmartDNS approval, compare-and-swap and expiration contracts.
-- All fixtures live inside a rolled-back transaction on disposable CI PostgreSQL.
BEGIN;
INSERT INTO dns_admin_domains(domain,product,status,requested_by,updated_by)
VALUES('owner-approval-test.example.org','custom','PENDING',99887766,99887766);
DO $$
DECLARE v_count integer;
BEGIN
  UPDATE dns_admin_domains SET status='APPLY_REQUESTED',revision=revision+1
   WHERE domain='owner-approval-test.example.org' AND status='PENDING'
   RETURNING revision INTO v_count;
  IF v_count<>2 THEN RAISE EXCEPTION 'First owner APPLY must claim revision 2'; END IF;

  UPDATE dns_admin_domains SET status='APPLY_REQUESTED',revision=revision+1
   WHERE domain='owner-approval-test.example.org' AND status='PENDING';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>0 THEN RAISE EXCEPTION 'Second APPLY must fail compare-and-swap'; END IF;

  UPDATE dns_admin_domains SET status='PROBING',canary_run_id=42812345001
   WHERE domain='owner-approval-test.example.org'
     AND revision=2 AND status='APPLY_REQUESTED';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'Only claimed row may enter PROBING'; END IF;

  UPDATE dns_admin_domains SET status='CANARY',
   canary_expires_at=now()+interval '60 minutes'
   WHERE domain='owner-approval-test.example.org' AND revision=2 AND status='PROBING';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'Cannot commit CANARY'; END IF;

  UPDATE dns_admin_domains SET status='CONFIRM_REQUESTED',revision=revision+1
   WHERE domain='owner-approval-test.example.org' AND status='CANARY'
   AND canary_expires_at>now()+interval '10 minutes';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'Valid keep must be accepted'; END IF;

  UPDATE dns_admin_domains SET status='CONFIRM_REQUESTED',revision=revision+1
   WHERE domain='owner-approval-test.example.org' AND status='CANARY';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>0 THEN RAISE EXCEPTION 'Replayed keep must fail'; END IF;

  UPDATE dns_admin_domains SET status='CONFIRMING'
   WHERE domain='owner-approval-test.example.org' AND revision=3
   AND status='CONFIRM_REQUESTED';
  UPDATE dns_admin_domains SET status='ACTIVE',confirmed_at=now()
   WHERE domain='owner-approval-test.example.org' AND revision=3
   AND status='CONFIRMING';
  UPDATE dns_admin_domains SET last_error_code='ACTIVE_ROUTE_CHECK_FAILED'
   WHERE domain='owner-approval-test.example.org' AND status='ACTIVE';
  IF (SELECT last_error_code FROM dns_admin_domains
      WHERE domain='owner-approval-test.example.org')<>'ACTIVE_ROUTE_CHECK_FAILED' THEN
    RAISE EXCEPTION 'ACTIVE health failure must be retained';
  END IF;

  UPDATE dns_admin_domains SET status='REMOVAL_PENDING',revision=revision+1
   WHERE domain='owner-approval-test.example.org' AND status='ACTIVE';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'Removal must claim ACTIVE'; END IF;
  UPDATE dns_admin_domains SET status='REMOVAL_PENDING',revision=revision+1
   WHERE domain='owner-approval-test.example.org' AND status='ACTIVE';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>0 THEN RAISE EXCEPTION 'Replayed removal must fail'; END IF;
END $$;
-- Expired CANARY must not satisfy the keep precondition.
UPDATE dns_admin_domains SET status='CANARY',
  canary_expires_at=now()-interval '1 minute'
 WHERE domain='owner-approval-test.example.org';
DO $$
DECLARE v_count integer;
BEGIN
  UPDATE dns_admin_domains SET status='CONFIRM_REQUESTED',revision=revision+1
    WHERE domain='owner-approval-test.example.org'
      AND status='CANARY' AND canary_expires_at>now()+interval '10 minutes';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>0 THEN RAISE EXCEPTION 'Expired CANARY must reject keep'; END IF;
END $$;
DO $$
BEGIN
  BEGIN
    UPDATE dns_admin_domains SET canary_expires_at=NULL
      WHERE domain='owner-approval-test.example.org' AND status='CANARY';
    RAISE EXCEPTION 'Missing deadline constraint';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;
ROLLBACK;
