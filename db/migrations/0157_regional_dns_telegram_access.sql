BEGIN;

CREATE FUNCTION public.telegram_regional_dns_subscription(p_telegram_user bigint)
RETURNS uuid LANGUAGE sql STABLE
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT e.id FROM public.accounts a
    JOIN public.entitlements e ON e.account_id=a.id
    JOIN public.orders o ON o.id=e.source_order_id
    WHERE a.telegram_user_id=p_telegram_user AND e.product='smart_dns'
    ORDER BY CASE WHEN e.state='ACTIVE' AND e.expires_at>statement_timestamp() THEN 0 ELSE 1 END,
      o.created_at DESC,e.expires_at DESC NULLS LAST,e.id LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.telegram_regional_dns_subscription(bigint) FROM PUBLIC;

CREATE FUNCTION public.telegram_regional_dns_revision(p_telegram_user bigint, p_country text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT CASE WHEN f.revoked_at IS NULL THEN COALESCE(f.credential_revision,0) END
    FROM public.entitlements e
    JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
    JOIN public.personal_dns_credentials c ON c.entitlement_id=e.id AND c.revoked_at IS NULL
    LEFT JOIN public.fi_dns_regional_credentials f ON f.entitlement_id=e.id
    WHERE p_country='FI' AND e.id=public.telegram_regional_dns_subscription(p_telegram_user)
      AND e.product='smart_dns' AND e.state='ACTIVE' AND o.state='PAID'
      AND e.dns_query_quota_per_30d IS NOT NULL
      AND e.starts_at<=statement_timestamp() AND e.expires_at>statement_timestamp()
      AND EXISTS(SELECT 1 FROM public.fi_dns_meter_gate WHERE singleton AND enabled);
$$;

CREATE FUNCTION public.telegram_issue_regional_dns_credential(
  p_telegram_user bigint, p_country text, p_label text, p_expected_revision bigint
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  account uuid;
  subscription uuid;
BEGIN
  IF p_country IS DISTINCT FROM 'FI' THEN RETURN 'DENY_REGION'; END IF;
  SELECT e.account_id,e.id INTO account,subscription FROM public.entitlements e
    WHERE e.id=public.telegram_regional_dns_subscription(p_telegram_user);
  IF NOT FOUND THEN RETURN 'DENY_INACTIVE'; END IF;
  RETURN public.issue_regional_dns_credential(account,subscription,p_country,p_label,p_expected_revision);
END;
$$;

REVOKE ALL ON FUNCTION public.telegram_regional_dns_revision(bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.telegram_issue_regional_dns_credential(bigint,text,text,bigint) FROM PUBLIC;
DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_bot') THEN
    GRANT EXECUTE ON FUNCTION public.telegram_regional_dns_revision(bigint,text),
      public.telegram_issue_regional_dns_credential(bigint,text,text,bigint) TO mnebyvpn_bot;
  END IF;
END;
$roles$;
COMMIT;
