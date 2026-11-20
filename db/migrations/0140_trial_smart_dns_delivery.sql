-- Allow 24h Smart DNS trials (orders.state = 'TRIAL') to issue and rotate
-- time-limited Personal DoT hostnames and Apple .mobileconfig profiles.
-- Enforcement remains strict: reserve_personal_dns_query() and
-- expire_due_entitlements() revoke Smart DNS routing at e.expires_at (24h).
-- Static Telegram WebSocket proxy links remain PAID-only so unexpiring
-- shared proxy links are never handed out on 24h trials.
BEGIN;

CREATE OR REPLACE FUNCTION website_personal_dns_status(p_session_sha text,p_entitlement uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'issued',c.credential_revision IS NOT NULL AND c.revoked_at IS NULL,
    'revision',c.credential_revision,
    'revoked',c.revoked_at IS NOT NULL
  )
  FROM public.website_sessions s
  JOIN public.entitlements e ON e.account_id=s.account_id AND e.id=p_entitlement
  JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
  LEFT JOIN public.personal_dns_credentials c ON c.entitlement_id=e.id
  WHERE s.token_sha256=p_session_sha AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp()
    AND e.product='smart_dns' AND e.state='ACTIVE'
    AND e.starts_at<=clock_timestamp() AND e.expires_at>clock_timestamp()
    AND o.state IN ('PAID','TRIAL') AND o.product IN ('smart_dns','bundle')
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION website_issue_personal_dns_credential(
  p_session_sha text,p_entitlement uuid,p_label text,p_token_sha text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.website_sessions s
    JOIN public.entitlements e ON e.account_id=s.account_id AND e.id=p_entitlement
    JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
    WHERE s.token_sha256=p_session_sha AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp()
      AND e.product='smart_dns' AND e.state='ACTIVE'
      AND e.starts_at<=clock_timestamp() AND e.expires_at>clock_timestamp()
      AND o.state IN ('PAID','TRIAL') AND o.product IN ('smart_dns','bundle');
  IF NOT FOUND THEN RETURN 'DENY_OWNER'; END IF;
  RETURN public.issue_personal_dns_credential(
    p_entitlement,p_label,p_token_sha,1000000);
END;
$$;

CREATE OR REPLACE FUNCTION website_rotate_personal_dns_credential(
  p_session_sha text,p_entitlement uuid,p_expected bigint,
  p_label text,p_token_sha text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE v_owner uuid;
BEGIN
  SELECT s.account_id INTO v_owner FROM public.website_sessions s
    JOIN public.entitlements e ON e.account_id=s.account_id AND e.id=p_entitlement
    JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
    WHERE s.token_sha256=p_session_sha AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp()
      AND e.product='smart_dns' AND e.state='ACTIVE'
      AND e.starts_at<=clock_timestamp() AND e.expires_at>clock_timestamp()
      AND o.state IN ('PAID','TRIAL') AND o.product IN ('smart_dns','bundle');
  IF NOT FOUND THEN RETURN 'DENY_OWNER'; END IF;
  RETURN public.rotate_personal_dns_credential(
    v_owner,p_entitlement,p_expected,p_label,p_token_sha);
END;
$$;

REVOKE ALL ON FUNCTION website_personal_dns_status(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION website_issue_personal_dns_credential(text,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION website_rotate_personal_dns_credential(text,uuid,bigint,text,text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
    GRANT EXECUTE ON FUNCTION website_personal_dns_status(text,uuid) TO mnebyvpn_site_auth;
    GRANT EXECUTE ON FUNCTION website_issue_personal_dns_credential(text,uuid,text,text) TO mnebyvpn_site_auth;
    GRANT EXECUTE ON FUNCTION website_rotate_personal_dns_credential(text,uuid,bigint,text,text) TO mnebyvpn_site_auth;
  END IF;
END $$;

COMMIT;
