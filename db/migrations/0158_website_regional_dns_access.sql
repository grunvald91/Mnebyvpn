-- FI website owner-scoped access, sharing existing DNS entitlement/quota.
BEGIN;
CREATE FUNCTION public.website_regional_dns_status(p_session_sha text,p_entitlement uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('issued',f.credential_revision IS NOT NULL AND f.revoked_at IS NULL,
   'revision',f.credential_revision,'revoked',f.revoked_at IS NOT NULL)
 FROM public.website_sessions s
 JOIN public.entitlements e ON e.account_id=s.account_id AND e.id=p_entitlement
 JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
 JOIN public.personal_dns_credentials c ON c.entitlement_id=e.id AND c.revoked_at IS NULL
 LEFT JOIN public.fi_dns_regional_credentials f ON f.entitlement_id=e.id
 WHERE s.token_sha256=p_session_sha AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
 AND e.product='smart_dns' AND e.state='ACTIVE' AND e.dns_query_quota_per_30d IS NOT NULL
 AND e.starts_at<=statement_timestamp() AND e.expires_at>statement_timestamp()
 AND o.state='PAID' AND o.product IN ('smart_dns','bundle')
 AND EXISTS(SELECT 1 FROM public.fi_dns_meter_gate WHERE singleton AND enabled)
 LIMIT 1;
$$;
CREATE FUNCTION public.website_issue_regional_dns_credential(
 p_session_sha text,p_entitlement uuid,p_label text,p_expected bigint
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_owner uuid;
BEGIN
 SELECT s.account_id INTO v_owner FROM public.website_sessions s
 JOIN public.entitlements e ON e.account_id=s.account_id AND e.id=p_entitlement
 JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
 WHERE s.token_sha256=p_session_sha AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND e.product='smart_dns' AND e.state='ACTIVE' AND e.dns_query_quota_per_30d IS NOT NULL
 AND e.starts_at<=clock_timestamp() AND e.expires_at>clock_timestamp()
 AND o.state='PAID' AND o.product IN ('smart_dns','bundle');
 IF NOT FOUND THEN RETURN 'DENY_OWNER'; END IF;
 RETURN public.issue_regional_dns_credential(v_owner,p_entitlement,'FI',p_label,p_expected);
END;
$$;
REVOKE ALL ON FUNCTION public.website_regional_dns_status(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.website_issue_regional_dns_credential(text,uuid,text,bigint) FROM PUBLIC;
DO $roles$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
  GRANT EXECUTE ON FUNCTION public.website_regional_dns_status(text,uuid),
   public.website_issue_regional_dns_credential(text,uuid,text,bigint) TO mnebyvpn_site_auth;
 END IF;
END;
$roles$;
COMMIT;
