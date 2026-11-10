-- Owner domain intake is a request queue. It MUST NOT grant active routing.
BEGIN;
DO $$
DECLARE v_count integer;
BEGIN
  IF (SELECT status FROM dns_admin_domains WHERE domain='oracle.com') <> 'PENDING'
     OR (SELECT status FROM dns_admin_domains WHERE domain='cloud.oracle.com') <> 'PENDING' THEN
    RAISE EXCEPTION 'Oracle candidate seed must be pending';
  END IF;
  SELECT count(*) INTO v_count FROM dns_admin_domains WHERE product='Oracle';
  IF v_count<>2 THEN RAISE EXCEPTION 'Unexpected Oracle candidate count'; END IF;
END $$;
INSERT INTO dns_admin_domains(domain,product,status,requested_by)
VALUES('owner-requested.example.org','custom','PENDING',99887766);
INSERT INTO dns_admin_domains(domain,product,status,requested_by)
VALUES('owner-requested.example.org','custom','PENDING',99887766)
ON CONFLICT (domain) DO NOTHING;
DO $$
BEGIN
  IF (SELECT count(*) FROM dns_admin_domains
        WHERE domain='owner-requested.example.org')<>1 THEN
    RAISE EXCEPTION 'Duplicate domain intake must not duplicate rows';
  END IF;
  IF (SELECT status FROM dns_admin_domains
        WHERE domain='owner-requested.example.org') <> 'PENDING' THEN
    RAISE EXCEPTION 'Intake cannot activate a route';
  END IF;
END $$;
UPDATE dns_admin_domains SET status='CANCELLED',updated_by=99887766,
  updated_at=now() WHERE domain='owner-requested.example.org';
DO $check$
BEGIN
  IF (SELECT status FROM dns_admin_domains WHERE domain='owner-requested.example.org')
     <> 'CANCELLED' THEN
     RAISE EXCEPTION 'Cancelled domain must not remain pending';
  END IF;
END $check$;
-- Bot can reopen only CANCELLED/FAILED, never implicitly touch ACTIVE.
INSERT INTO dns_admin_domains(domain,product,status,requested_by,updated_by)
VALUES('owner-requested.example.org','custom','PENDING',99887766,99887766)
ON CONFLICT(domain) DO UPDATE SET status='PENDING',updated_by=EXCLUDED.updated_by,
  updated_at=now() WHERE dns_admin_domains.status IN ('CANCELLED','FAILED');
DO $check$
BEGIN
  IF (SELECT status FROM dns_admin_domains WHERE domain='owner-requested.example.org')
     <> 'PENDING' THEN
     RAISE EXCEPTION 'Cancelled domain should be requeueable';
  END IF;
END $check$;
ROLLBACK;
