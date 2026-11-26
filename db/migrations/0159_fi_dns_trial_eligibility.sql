-- One eligibility policy for FI issuance, menu, metering and signed grants.
-- Existing paid native-query subscriptions stay eligible. A free trial must
-- have an activated, matching canonical trial grant and original 24h deadline.
-- No trial or quota is created or extended by this migration.
BEGIN;
CREATE FUNCTION public.fi_dns_entitlement_eligible(p_entitlement uuid,p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.entitlements e
  JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
  WHERE e.id=p_entitlement AND e.product='smart_dns' AND e.state='ACTIVE'
    AND e.starts_at<=p_at AND e.expires_at>p_at
    AND (
      (o.state='PAID' AND e.dns_query_quota_per_30d IS NOT NULL)
      OR (o.state='TRIAL' AND o.provider='internal_trial' AND o.amount_minor=0
          AND o.product IN ('smart_dns','bundle')
          AND EXISTS(SELECT 1 FROM public.trial_grants t
           WHERE t.order_id=o.id AND t.account_id=e.account_id AND t.product=o.product
             AND t.activated_at=e.starts_at AND t.access_expires_at=e.expires_at
             AND t.access_expires_at=t.activated_at+interval '24 hours'
             AND t.access_expires_at>p_at))
    )
 );
$$;
REVOKE ALL ON FUNCTION public.fi_dns_entitlement_eligible(uuid,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.fi_dns_meter_apply(p_op text,p_request uuid,p_digest text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  m public.fi_dns_meter_requests%ROWTYPE;
  f public.fi_dns_regional_credentials%ROWTYPE;
  c public.personal_dns_credentials%ROWTYPE;
  e public.entitlements%ROWTYPE;
  v_e uuid;
  v_now timestamptz;
  v_period bigint;
  v_result text;
  expired record;
  v_active boolean;
BEGIN
  IF p_request IS NULL OR p_op IS NULL OR p_op NOT IN ('reserve','settle','release')
    OR (p_op='reserve' AND (p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'))
    OR (p_op<>'reserve' AND p_digest IS NOT NULL)
  THEN RETURN 'DENY_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fi-dns-meter:'||p_request::text,0));
  SELECT * INTO m FROM public.fi_dns_meter_requests WHERE request_id=p_request;
  IF p_op='reserve' THEN
    -- Every retry is denied, including a reserve arriving after a release.
    IF FOUND THEN RETURN 'DENY_DUPLICATE'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.fi_dns_meter_gate WHERE singleton AND enabled)
    THEN RETURN 'DENY_DISABLED'; END IF;
    SELECT entitlement_id INTO v_e FROM public.fi_dns_regional_credentials WHERE token_sha256=p_digest;
    IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
  ELSE
    IF NOT FOUND THEN
      IF p_op='release' THEN
        INSERT INTO public.fi_dns_meter_requests(request_id,state) VALUES(p_request,'RELEASED');
        RETURN 'RELEASED';
      END IF;
      RETURN 'DENY_UNKNOWN';
    END IF;
    IF m.state <> 'RESERVED' THEN RETURN m.state; END IF;
    v_e:=m.entitlement_id;
  END IF;
  SELECT * INTO e FROM public.entitlements WHERE id=v_e FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
  SELECT * INTO c FROM public.personal_dns_credentials WHERE entitlement_id=v_e;
  SELECT * INTO f FROM public.fi_dns_regional_credentials WHERE entitlement_id=v_e;
  v_now:=clock_timestamp();
  -- Shared paid/trial policy; the canonical DE credential supplies the
  -- query allowance for existing byte-backed 24-hour trial entitlements.
  v_active:=COALESCE(
    f.revoked_at IS NULL AND c.revoked_at IS NULL AND f.token_sha256 IS NOT NULL
    AND public.fi_dns_entitlement_eligible(e.id,v_now)
    AND EXISTS(SELECT 1 FROM public.fi_dns_meter_gate WHERE singleton AND enabled),false);
  IF p_op='reserve' THEN
    IF NOT v_active OR f.token_sha256 IS DISTINCT FROM p_digest THEN RETURN 'DENY_INACTIVE'; END IF;
    v_period:=floor(extract(epoch FROM(v_now-e.starts_at))/2592000)::bigint;
    -- Identical recovery semantics to the current legacy reserve function.
    FOR expired IN
      DELETE FROM public.personal_dns_query_reservations
      WHERE entitlement_id=v_e AND expires_at<=v_now RETURNING period_index
    LOOP
      UPDATE public.personal_dns_query_windows SET reserved_queries=reserved_queries-1,updated_at=v_now
      WHERE entitlement_id=v_e AND period_index=expired.period_index;
    END LOOP;
    INSERT INTO public.personal_dns_query_windows(entitlement_id,period_index)
      VALUES(v_e,v_period) ON CONFLICT DO NOTHING;
    UPDATE public.personal_dns_query_windows SET reserved_queries=reserved_queries+1,updated_at=v_now
      WHERE entitlement_id=v_e AND period_index=v_period
      AND used_queries+reserved_queries<LEAST(c.query_limit_per_30d,COALESCE(e.dns_query_quota_per_30d,c.query_limit_per_30d));
    IF NOT FOUND THEN RETURN 'DENY_QUOTA'; END IF;
    -- Keep the existing reservation table so legacy ingress also recovers
    -- expired regional holds. Store the canonical legacy digest internally.
    INSERT INTO public.personal_dns_query_reservations(request_id,entitlement_id,period_index,token_sha256,expires_at)
      VALUES(p_request,v_e,v_period,c.token_sha256,v_now+interval '15 seconds')
      ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN
      UPDATE public.personal_dns_query_windows SET reserved_queries=reserved_queries-1
        WHERE entitlement_id=v_e AND period_index=v_period;
      RETURN 'DENY_DUPLICATE';
    END IF;
    INSERT INTO public.fi_dns_meter_requests(request_id,entitlement_id,token_sha256,credential_revision,reservation_expires_at,state)
      VALUES(p_request,v_e,p_digest,f.credential_revision,v_now+interval '15 seconds','RESERVED');
    RETURN 'RESERVED';
  END IF;
  -- Region revoke/rotation, expiry, gate OFF or refund blocks settlement.
  -- Existing legacy function also verifies its original credential digest.
  IF NOT EXISTS(SELECT 1 FROM public.personal_dns_query_reservations
      WHERE request_id=p_request AND entitlement_id=v_e
        AND expires_at=m.reservation_expires_at) THEN
    UPDATE public.fi_dns_meter_requests SET state='RELEASED' WHERE request_id=p_request;
    RETURN 'RELEASED';
  END IF;
  v_result:=public.finish_personal_dns_query(p_request,
    p_op='settle' AND v_active AND f.token_sha256 IS NOT DISTINCT FROM m.token_sha256
    AND f.credential_revision IS NOT DISTINCT FROM m.credential_revision);
  UPDATE public.fi_dns_meter_requests SET state=CASE WHEN v_result='SETTLED' THEN 'SETTLED' ELSE 'RELEASED' END
    WHERE request_id=p_request;
  RETURN CASE WHEN v_result='SETTLED' THEN 'SETTLED' ELSE 'RELEASED' END;
END $$;

CREATE OR REPLACE FUNCTION public.fi_dns_snapshot_next()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_enabled boolean; v_now timestamptz; v_revision bigint;
 v_grants jsonb; v_count bigint;
BEGIN
 -- Serialize publishers, and read the latest committed entitlement state.
 -- The worker must use a dedicated autocommit READ COMMITTED connection.
 IF current_setting('transaction_isolation')<>'read committed'
 THEN RAISE EXCEPTION 'Snapshot publisher requires read committed'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('fi-dns-snapshot-v1',0));
 SELECT enabled INTO v_enabled FROM public.fi_dns_meter_gate WHERE singleton FOR SHARE;
 v_now:=clock_timestamp();
 IF COALESCE(v_enabled,false) THEN
  SELECT count(*),COALESCE(jsonb_agg(grant_row ORDER BY digest),'[]'::jsonb)
  INTO v_count,v_grants
  FROM (
   SELECT f.token_sha256 AS digest,jsonb_build_object(
    'entitlementId',e.id::text,
    'credentialRevision',f.credential_revision,
    'tokenSha256',f.token_sha256,
    'expiresAt',to_char(LEAST(e.expires_at,v_now+interval '365 days') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'state','ACTIVE') AS grant_row
   FROM public.fi_dns_regional_credentials f
   JOIN public.personal_dns_credentials c ON c.entitlement_id=f.entitlement_id
   JOIN public.entitlements e ON e.id=f.entitlement_id
   JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
   WHERE f.revoked_at IS NULL AND c.revoked_at IS NULL
    AND public.fi_dns_entitlement_eligible(e.id,v_now)
   ORDER BY f.token_sha256 LIMIT 2049
  ) AS eligible;
  IF v_count>2048 THEN RAISE EXCEPTION 'FI snapshot capacity exceeded'; END IF;
 ELSE v_grants:='[]'::jsonb;
 END IF;
 -- Nontransactional sequence never reuses a revision after rollback.
 v_revision:=nextval('public.fi_dns_snapshot_revision_seq'::regclass);
 RETURN jsonb_build_object('revision',v_revision,
  'issuedAt',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'validUntil',to_char((v_now+interval '90 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'grants',v_grants);
END $$;

CREATE OR REPLACE FUNCTION public.issue_regional_dns_credential(
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
  IF NOT public.fi_dns_entitlement_eligible(entitlement.id,clock_timestamp())
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

CREATE OR REPLACE FUNCTION public.telegram_regional_dns_revision(p_telegram_user bigint, p_country text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT CASE WHEN f.revoked_at IS NULL THEN COALESCE(f.credential_revision,0) END
    FROM public.entitlements e
    JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
    JOIN public.personal_dns_credentials c ON c.entitlement_id=e.id AND c.revoked_at IS NULL
    LEFT JOIN public.fi_dns_regional_credentials f ON f.entitlement_id=e.id
    WHERE p_country='FI' AND e.id=public.telegram_regional_dns_subscription(p_telegram_user)
      AND public.fi_dns_entitlement_eligible(e.id,statement_timestamp())
      AND EXISTS(SELECT 1 FROM public.fi_dns_meter_gate WHERE singleton AND enabled);
$$;

CREATE OR REPLACE FUNCTION public.website_regional_dns_status(p_session_sha text,p_entitlement uuid)
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
 AND public.fi_dns_entitlement_eligible(e.id,statement_timestamp())
 AND EXISTS(SELECT 1 FROM public.fi_dns_meter_gate WHERE singleton AND enabled)
 LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.website_issue_regional_dns_credential(
 p_session_sha text,p_entitlement uuid,p_label text,p_expected bigint
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_owner uuid;
BEGIN
 SELECT s.account_id INTO v_owner FROM public.website_sessions s
 JOIN public.entitlements e ON e.account_id=s.account_id AND e.id=p_entitlement
 JOIN public.orders o ON o.id=e.source_order_id AND o.account_id=e.account_id
 WHERE s.token_sha256=p_session_sha AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND public.fi_dns_entitlement_eligible(e.id,clock_timestamp());
 IF NOT FOUND THEN RETURN 'DENY_OWNER'; END IF;
 RETURN public.issue_regional_dns_credential(v_owner,p_entitlement,'FI',p_label,p_expected);
END;
$$;
COMMIT;
