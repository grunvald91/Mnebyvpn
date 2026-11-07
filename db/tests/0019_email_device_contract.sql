BEGIN;
INSERT INTO accounts(id,email_address) VALUES
 ('93000000-0000-4000-8000-000000000001','first@example.org'),
 ('93000000-0000-4000-8000-000000000002','second@example.org');
DO $$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
  INSERT INTO accounts(id,email_address)
   VALUES('93000000-0000-4000-8000-000000000003','first@example.org');
 EXCEPTION WHEN unique_violation THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'Same verified email acquired 2 accounts'; END IF;
END; $$;
INSERT INTO trial_device_claims(device_hash,account_id)
 VALUES(repeat('a',64),'93000000-0000-4000-8000-000000000001');
DO $$
DECLARE accepted integer;
BEGIN
 INSERT INTO trial_device_claims(device_hash,account_id)
  VALUES(repeat('a',64),'93000000-0000-4000-8000-000000000002')
  ON CONFLICT(device_hash) DO NOTHING;
 GET DIAGNOSTICS accepted=ROW_COUNT;
 IF accepted<>0 THEN RAISE EXCEPTION 'Same browser claimed 2 trial owners'; END IF;
END; $$;
INSERT INTO web_email_codes(email,code_hash,expires_at)
 VALUES('first@example.org',repeat('f',64),clock_timestamp()+interval '10 minutes');
DO $$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
  INSERT INTO web_email_codes(email,code_hash,expires_at)
   VALUES('first@example.org',repeat('a',64),clock_timestamp()+interval '10 minutes');
 EXCEPTION WHEN unique_violation THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'OTP challenge uniqueness broken'; END IF;
END; $$;
ROLLBACK;
