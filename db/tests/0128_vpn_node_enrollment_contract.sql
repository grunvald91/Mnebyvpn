BEGIN;
DO $$
DECLARE was_blocked boolean;
BEGIN
  INSERT INTO vpn_node_enrollment_inventory(
    node_id,endpoint_host,identity_public_spki)
  VALUES ('test-node-01','test-node-01.example.net',repeat('A',59));

  IF (SELECT status FROM vpn_node_enrollment_inventory
       WHERE node_id='test-node-01')<>'planned' THEN
    RAISE EXCEPTION 'Node must not auto-approve enrollment'; END IF;

  BEGIN
    INSERT INTO vpn_node_enrollment_challenges(
      challenge_id,node_id,nonce_sha256,expires_at)
    VALUES('11111111-2222-4333-8444-555555555555',
      'test-node-01',repeat('a',64),clock_timestamp()+interval '10 minutes');
    RAISE EXCEPTION 'Long-lived enrollment challenge allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO vpn_node_enrollment_inventory(
      node_id,endpoint_host,identity_public_spki)
    VALUES('test-node-02','test-node-01.example.net',repeat('B',59));
    RAISE EXCEPTION 'Enrolled server FQDN was reused';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  UPDATE vpn_node_enrollment_inventory SET
    status='approved',approved_at=clock_timestamp() WHERE node_id='test-node-01';
  UPDATE vpn_node_enrollment_inventory SET
    status='enrolled',enrolled_at=clock_timestamp() WHERE node_id='test-node-01';

  was_blocked:=false;
  BEGIN
    UPDATE vpn_node_enrollment_inventory SET identity_public_spki=repeat('B',59)
      WHERE node_id='test-node-01';
  EXCEPTION WHEN raise_exception THEN was_blocked:=true; END;
  IF NOT was_blocked THEN RAISE EXCEPTION 'Enrolled identity overwritten'; END IF;

  was_blocked:=false;
  BEGIN
    UPDATE vpn_node_enrollment_inventory SET status='planned'
      WHERE node_id='test-node-01';
  EXCEPTION WHEN raise_exception THEN was_blocked:=true; END;
  IF NOT was_blocked THEN RAISE EXCEPTION 'Enrolled identity reset'; END IF;

  UPDATE vpn_node_enrollment_inventory SET status='revoked'
    WHERE node_id='test-node-01';
  was_blocked:=false;
  BEGIN
    UPDATE vpn_node_enrollment_inventory SET
      status='approved',approved_at=clock_timestamp()
      WHERE node_id='test-node-01';
  EXCEPTION WHEN raise_exception THEN was_blocked:=true; END;
  IF NOT was_blocked THEN RAISE EXCEPTION 'Revoked identity reused'; END IF;

  IF EXISTS(
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid='vpn_node_enrollment_challenges'::regclass AND a.grantee=0
  ) THEN RAISE EXCEPTION 'Public can read one-time challenges'; END IF;
  IF EXISTS(
    SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid='vpn_node_enrollment_inventory'::regclass AND a.grantee=0
  ) THEN RAISE EXCEPTION 'Public can read node identities'; END IF;
END $$;
ROLLBACK;
