-- Fail closed for directly forged approvals and enrolled statuses.
BEGIN;
DO $$
DECLARE blocked boolean;
BEGIN
  blocked:=false;
  BEGIN
    INSERT INTO vpn_node_enrollment_inventory(
      node_id,endpoint_host,identity_public_spki,status,approved_at)
    VALUES('test-guard-01','guard01.example.net',repeat('A',59),
      'approved',clock_timestamp());
  EXCEPTION WHEN raise_exception THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Direct approval insertion accepted'; END IF;

  INSERT INTO vpn_node_enrollment_inventory(
    node_id,endpoint_host,identity_public_spki)
  VALUES('test-guard-01','guard01.example.net',repeat('A',59));

  blocked:=false;
  BEGIN
    UPDATE vpn_node_enrollment_inventory SET
      status='enrolled',approved_at=clock_timestamp(),
      enrolled_at=clock_timestamp()
    WHERE node_id='test-guard-01';
  EXCEPTION WHEN raise_exception THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Skipped approval state accepted'; END IF;

  UPDATE vpn_node_enrollment_inventory SET
    status='approved',approved_at=clock_timestamp()
  WHERE node_id='test-guard-01';

  blocked:=false;
  BEGIN
    UPDATE vpn_node_enrollment_inventory SET
      endpoint_host='malicious.example.net' WHERE node_id='test-guard-01';
  EXCEPTION WHEN raise_exception THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Approved host substitution accepted'; END IF;

  blocked:=false;
  BEGIN
    UPDATE vpn_node_enrollment_inventory SET
      status='enrolled',enrolled_at=clock_timestamp()
    WHERE node_id='test-guard-01';
  EXCEPTION WHEN raise_exception THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Enrollment without consumed nonce accepted'; END IF;

  INSERT INTO vpn_node_enrollment_challenges(
    challenge_id,node_id,nonce_sha256,issued_at,expires_at,consumed_at)
  VALUES ('33333333-3333-4333-8333-333333333333',
    'test-guard-01',repeat('c',64),
    clock_timestamp()-interval '4 minutes',
    clock_timestamp()-interval '1 minute',
    clock_timestamp()-interval '2 minutes');
  blocked:=false;
  BEGIN
    UPDATE vpn_node_enrollment_inventory SET
      status='enrolled',enrolled_at=clock_timestamp()
    WHERE node_id='test-guard-01';
  EXCEPTION WHEN raise_exception THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Expired consumed nonce accepted'; END IF;

  INSERT INTO vpn_node_enrollment_challenges(
    challenge_id,node_id,nonce_sha256,issued_at,expires_at,consumed_at)
  VALUES('44444444-4444-4444-8444-444444444444',
    'test-guard-01',repeat('d',64),
    clock_timestamp()-interval '2 seconds',
    clock_timestamp()+interval '4 minutes',
    clock_timestamp());
  UPDATE vpn_node_enrollment_inventory SET
    status='enrolled',enrolled_at=clock_timestamp()
  WHERE node_id='test-guard-01';
  IF (SELECT status FROM vpn_node_enrollment_inventory
      WHERE node_id='test-guard-01')<>'enrolled' THEN
    RAISE EXCEPTION 'Valid consumed challenge denied'; END IF;
  UPDATE vpn_node_enrollment_inventory SET status='revoked'
    WHERE node_id='test-guard-01';
  blocked:=false;
  BEGIN
    UPDATE vpn_node_enrollment_inventory SET status='enrolled'
      WHERE node_id='test-guard-01';
  EXCEPTION WHEN raise_exception THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Revoked identity restored'; END IF;
END $$;
ROLLBACK;
