-- Signed grant state distinguishes canonical bundle trials from legacy profiles.
-- Deploy trial-aware FI validators and customer runtime before publishing trial grants.
BEGIN;
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
    'state',CASE WHEN o.state='TRIAL' AND o.provider='internal_trial' AND o.product='bundle' AND o.amount_minor=0 THEN 'ACTIVE_TRIAL' ELSE 'ACTIVE' END) AS grant_row
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
COMMIT;
