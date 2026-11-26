-- Regional DoT profiles attach to the existing subscription, never to a
-- regional quota window. The German profile remains the canonical credential.
BEGIN;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_regional_dns_issuer') THEN
    CREATE ROLE mnebyvpn_regional_dns_issuer NOLOGIN NOINHERIT;
  END IF;
END;
$role$;

CREATE FUNCTION public.issue_regional_dns_credential(
  p_account uuid, p_entitlement uuid, p_country text, p_label text, p_expected_revision bigint
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  entitlement public.entitlements%ROWTYPE;
  regional public.fi_dns_regional_credentials%ROWTYPE;
  digest text;
BEGIN
  -- A region is eligible only after its authenticated data plane exists.
  -- DE already uses the independent legacy credential on this subscription.
  IF p_country IS DISTINCT FROM 'FI' THEN RETURN 'DENY_REGION'; END IF;
  IF p_account IS NULL OR p_entitlement IS NULL OR p_label IS NULL
     OR p_label !~ '^[a-z0-9]{12}$'
     OR p_label IN ('aaaaaaaaaaaa','bbbbbbbbbbbb')
     OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 999999999
  THEN RETURN 'DENY_INVALID'; END IF;

  SELECT * INTO entitlement FROM public.entitlements
    WHERE id=p_entitlement AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_OWNER'; END IF;
  IF entitlement.product<>'smart_dns' OR entitlement.state<>'ACTIVE'
     OR entitlement.dns_query_quota_per_30d IS NULL
     OR entitlement.starts_at IS NULL OR entitlement.expires_at IS NULL
     OR entitlement.starts_at>clock_timestamp() OR entitlement.expires_at<=clock_timestamp()
     OR NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.id=entitlement.source_order_id
         AND o.account_id=p_account AND o.state='PAID')
     OR NOT EXISTS(SELECT 1 FROM public.personal_dns_credentials c
         WHERE c.entitlement_id=p_entitlement AND c.revoked_at IS NULL)
  THEN RETURN 'DENY_INACTIVE'; END IF;

  PERFORM 1 FROM public.fi_dns_meter_gate WHERE singleton AND enabled FOR SHARE;
  IF NOT FOUND THEN RETURN 'DENY_DISABLED'; END IF;
  digest:=encode(sha256(
    convert_to('MNEBYVPN_COUNTRY_DNS_V1','UTF8') || decode('00','hex') ||
    convert_to(p_country,'UTF8') || decode('00','hex') || convert_to(p_label,'UTF8')
  ),'hex');
  SELECT * INTO regional FROM public.fi_dns_regional_credentials WHERE entitlement_id=p_entitlement;
  IF NOT FOUND THEN
    IF p_expected_revision<>0 THEN RETURN 'DENY_STALE'; END IF;
    INSERT INTO public.fi_dns_regional_credentials(entitlement_id,token_sha256,credential_revision)
      VALUES(p_entitlement,digest,1) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RETURN 'DENY_TOKEN_COLLISION'; END IF;
    RETURN 'ISSUED';
  END IF;
  IF regional.revoked_at IS NOT NULL THEN RETURN 'DENY_REVOKED'; END IF;
  IF regional.token_sha256=digest THEN RETURN 'ALREADY_ISSUED'; END IF;
  IF p_expected_revision<>regional.credential_revision THEN RETURN 'DENY_STALE'; END IF;
  BEGIN
    UPDATE public.fi_dns_regional_credentials
       SET token_sha256=digest,credential_revision=regional.credential_revision+1
       WHERE entitlement_id=p_entitlement;
  EXCEPTION WHEN unique_violation THEN RETURN 'DENY_TOKEN_COLLISION';
  END;
  RETURN 'ROTATED';
END;
$$;

REVOKE ALL ON FUNCTION public.issue_regional_dns_credential(uuid,uuid,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_regional_dns_credential(uuid,uuid,text,text,bigint)
  TO mnebyvpn_regional_dns_issuer;
COMMIT;
