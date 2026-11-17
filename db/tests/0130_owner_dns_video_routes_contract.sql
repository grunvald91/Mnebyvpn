-- Run after migration 0130, inside a rolled-back transaction.
BEGIN;
DO $$
DECLARE decision text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.owner_dns_links
    WHERE video_route NOT IN ('vpn_origin','smart_dns')
  ) THEN RAISE EXCEPTION 'invalid route in owner links'; END IF;

  -- Old permanent link: unchanged identity and direct/origin decision.
  INSERT INTO public.owner_dns_links(
    id,owner_telegram_id,token_sha256,token_ciphertext,request_key,
    permanent,expires_at
  ) VALUES (
    'b1111111-1111-4111-8111-111111111111',991,
    encode(sha256(convert_to('vpnlegacy001','UTF8')),'hex'),
    repeat('x',54),'permanent',true,NULL
  );
  IF public.owner_dns_link_status('vpnlegacy001')<>'ALLOWED'
    THEN RAISE EXCEPTION 'existing VPN link compatibility failed';END IF;

  -- One separate permanent Smart DNS link for the same owner.
  INSERT INTO public.owner_dns_links(
    id,owner_telegram_id,token_sha256,token_ciphertext,request_key,
    permanent,expires_at,video_route
  ) VALUES (
    'b2222222-2222-4222-8222-222222222222',991,
    encode(sha256(convert_to('smartdns0001','UTF8')),'hex'),
    repeat('x',54),'smartdns:permanent',true,NULL,'smart_dns'
  );
  IF public.owner_dns_link_status('smartdns0001')<>'ALLOWED_SMART_DNS'
    THEN RAISE EXCEPTION 'Smart DNS link route not recognized';END IF;

  -- An attacker cannot create another permanent link in either route.
  BEGIN
    INSERT INTO public.owner_dns_links(
      id,owner_telegram_id,token_sha256,token_ciphertext,request_key,
      permanent,expires_at,video_route
    ) VALUES (
      'b3333333-3333-4333-8333-333333333333',991,
      repeat('a',64),repeat('x',54),'smartdns:second',true,NULL,'smart_dns'
    );
    RAISE EXCEPTION 'duplicate Smart DNS permanent link accepted';
  EXCEPTION WHEN unique_violation THEN NULL;END;

  -- Invalid labels never become authorized, and revocation affects both modes.
  IF public.owner_dns_link_status('invalid.label')<>'UNKNOWN'
    THEN RAISE EXCEPTION 'bad credential accepted';END IF;
  UPDATE public.owner_dns_links SET revoked_at=clock_timestamp()
    WHERE request_key='smartdns:permanent' AND owner_telegram_id=991;
  IF public.owner_dns_link_status('smartdns0001')<>'DENY_INACTIVE'
    THEN RAISE EXCEPTION 'revoked Smart DNS remains active';END IF;
  IF public.owner_dns_link_status('vpnlegacy001')<>'ALLOWED'
    THEN RAISE EXCEPTION 'VPN link unexpectedly revoked';END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE p.oid='owner_dns_link_status(text)'::regprocedure AND a.grantee=0
  ) THEN RAISE EXCEPTION 'public can authorize owner links';END IF;
END $$;
ROLLBACK;
