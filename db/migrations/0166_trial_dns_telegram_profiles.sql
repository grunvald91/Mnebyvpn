-- Scope trial bot actions to the canonical bundle, never the latest paid DNS.
BEGIN;
CREATE FUNCTION public.telegram_bundle_trial_dns_entitlement(p_actor bigint)
RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id FROM public.accounts a JOIN public.trial_grants t ON t.account_id=a.id
 JOIN public.orders o ON o.id=t.order_id AND o.account_id=a.id
 JOIN public.entitlements e ON e.source_order_id=o.id AND e.account_id=a.id
 JOIN public.entitlements v ON v.source_order_id=o.id AND v.account_id=a.id AND v.product='vpn'
 WHERE a.telegram_user_id=p_actor AND t.product='bundle' AND o.product='bundle'
 AND o.provider='internal_trial' AND o.state='TRIAL' AND o.amount_minor=0
 AND e.product='smart_dns' AND e.state='ACTIVE' AND v.state='ACTIVE'
 AND e.starts_at=t.activated_at AND v.starts_at=t.activated_at
 AND e.expires_at=t.access_expires_at AND v.expires_at=t.access_expires_at
 AND t.access_expires_at=t.activated_at+interval '24 hours'
 AND t.activated_at<=statement_timestamp() AND t.access_expires_at>statement_timestamp()
 LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.telegram_bundle_trial_dns_entitlement(bigint) FROM PUBLIC;
CREATE FUNCTION public.telegram_bundle_trial_dns_status(p_actor bigint)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('deRevision',CASE WHEN c.revoked_at IS NULL THEN COALESCE(c.credential_revision,0) END,
 'fiRevision',CASE WHEN c.entitlement_id IS NOT NULL AND c.revoked_at IS NULL AND f.revoked_at IS NULL
 AND EXISTS(SELECT 1 FROM public.fi_dns_meter_gate WHERE singleton AND enabled)
 THEN COALESCE(f.credential_revision,0) END)
 FROM public.entitlements e
 LEFT JOIN public.personal_dns_credentials c ON c.entitlement_id=e.id
 LEFT JOIN public.fi_dns_regional_credentials f ON f.entitlement_id=e.id
 WHERE e.id=public.telegram_bundle_trial_dns_entitlement(p_actor)
$$;
CREATE FUNCTION public.telegram_bundle_trial_dns_issue(p_actor bigint,p_country text,p_label text,p_expected bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id uuid; v_account uuid; v_hash text;
BEGIN
 IF p_country IS NULL OR p_country NOT IN ('DE','FI') OR p_label IS NULL
 OR p_label !~ '^[a-z0-9]{12}$' OR p_expected IS NULL OR p_expected NOT BETWEEN 0 AND 999999999
 THEN RETURN 'DENY_INVALID'; END IF;
 v_id:=public.telegram_bundle_trial_dns_entitlement(p_actor);
 SELECT account_id INTO v_account FROM public.entitlements WHERE id=v_id FOR UPDATE;
 IF NOT FOUND OR public.telegram_bundle_trial_dns_entitlement(p_actor) IS DISTINCT FROM v_id
 THEN RETURN 'DENY_INACTIVE'; END IF;
 IF p_country='FI' THEN
 RETURN public.issue_regional_dns_credential(v_account,v_id,'FI',p_label,p_expected);
 END IF;
 v_hash:=encode(sha256(convert_to(p_label,'UTF8')),'hex');
 IF p_expected=0 THEN RETURN public.issue_personal_dns_credential(v_id,p_label,v_hash,30000); END IF;
 RETURN public.rotate_personal_dns_credential(v_account,v_id,p_expected,p_label,v_hash);
END $$;
REVOKE ALL ON FUNCTION public.telegram_bundle_trial_dns_status(bigint),public.telegram_bundle_trial_dns_issue(bigint,text,text,bigint) FROM PUBLIC;
DO $roles$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_bot') THEN
 GRANT EXECUTE ON FUNCTION public.telegram_bundle_trial_dns_status(bigint),public.telegram_bundle_trial_dns_issue(bigint,text,text,bigint) TO mnebyvpn_bot;
 END IF;
END $roles$;
COMMIT;
