-- Private FI policy source, sharing the actual meter's paid eligibility.
-- No credentials are issued and no release gate is enabled by migration.
BEGIN;
CREATE SEQUENCE public.fi_dns_snapshot_revision_seq AS bigint
 MINVALUE 1 MAXVALUE 1000000000 NO CYCLE;
REVOKE ALL ON SEQUENCE public.fi_dns_snapshot_revision_seq FROM PUBLIC;

CREATE FUNCTION public.fi_dns_snapshot_next()
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
    AND e.product='smart_dns' AND e.state='ACTIVE'
    AND e.starts_at<=v_now AND e.expires_at>v_now
    AND e.dns_query_quota_per_30d IS NOT NULL AND o.state='PAID'
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
REVOKE ALL ON FUNCTION public.fi_dns_snapshot_next() FROM PUBLIC;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_fi_dns_publisher') THEN
  CREATE ROLE mnebyvpn_fi_dns_publisher NOLOGIN NOINHERIT;
 END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.fi_dns_snapshot_next() TO mnebyvpn_fi_dns_publisher;
COMMIT;
