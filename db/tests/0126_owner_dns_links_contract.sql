BEGIN;
DO $$
DECLARE decision text;
BEGIN
  INSERT INTO owner_dns_links(id,owner_telegram_id,token_sha256,token_ciphertext,request_key,permanent,expires_at)
  VALUES ('11111111-1111-4111-8111-111111111111',123,encode(sha256(convert_to('abcdefghijkl','UTF8')),'hex'),repeat('x',54),'permanent',true,NULL);
  IF owner_dns_link_status('abcdefghijkl')<>'ALLOWED' THEN RAISE EXCEPTION 'permanent denied';END IF;
  IF owner_dns_link_status('bbbbbbbbbbbb')<>'UNKNOWN' THEN RAISE EXCEPTION 'unknown allowed';END IF;
  IF owner_dns_link_status('bad.label')<>'UNKNOWN' THEN RAISE EXCEPTION 'malformed allowed';END IF;
  BEGIN
    INSERT INTO owner_dns_links(id,owner_telegram_id,token_sha256,token_ciphertext,request_key,permanent,expires_at)
    VALUES ('22222222-2222-4222-8222-222222222222',123,repeat('b',64),repeat('x',54),'second-permanent',true,NULL);
    RAISE EXCEPTION 'second permanent allowed';
  EXCEPTION WHEN unique_violation THEN NULL;END;
  INSERT INTO owner_dns_links(id,owner_telegram_id,token_sha256,token_ciphertext,request_key,permanent,expires_at)
  VALUES ('33333333-3333-4333-8333-333333333333',123,encode(sha256(convert_to('cccccccccccc','UTF8')),'hex'),repeat('x',54),'temp',false,clock_timestamp()+interval '1 hour');
  IF owner_dns_link_status('cccccccccccc')<>'ALLOWED' THEN RAISE EXCEPTION 'temporary denied';END IF;
  UPDATE owner_dns_links SET expires_at=clock_timestamp()-interval '1 second' WHERE request_key='temp';
  IF owner_dns_link_status('cccccccccccc')<>'DENY_INACTIVE' THEN RAISE EXCEPTION 'expired allowed';END IF;
  UPDATE owner_dns_links SET revoked_at=clock_timestamp() WHERE request_key='permanent';
  IF owner_dns_link_status('abcdefghijkl')<>'DENY_INACTIVE' THEN RAISE EXCEPTION 'revoked allowed';END IF;
  IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid='owner_dns_links'::regclass AND a.grantee=0) THEN RAISE EXCEPTION 'public can read bearers';END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid='owner_dns_link_status(text)'::regprocedure AND a.grantee=0) THEN RAISE EXCEPTION 'public can authorize';END IF;
END $$;
ROLLBACK;
