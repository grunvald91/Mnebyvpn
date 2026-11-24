-- Dormant FI query-meter storage. Reuses the legacy entitlement lock, quota
-- windows and reservation expiry, so regional traffic cannot create a new budget.
-- No credentials issued, no worker installed, no public grant or release enabled.
BEGIN;
CREATE TABLE public.fi_dns_meter_gate (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false
);
INSERT INTO public.fi_dns_meter_gate(singleton,enabled) VALUES(true,false);
CREATE TABLE public.fi_dns_regional_credentials (
  entitlement_id uuid PRIMARY KEY REFERENCES public.personal_dns_credentials(entitlement_id) ON DELETE RESTRICT,
  token_sha256 text NOT NULL UNIQUE CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
  credential_revision bigint NOT NULL CHECK(credential_revision BETWEEN 1 AND 1000000000),
  revoked_at timestamptz
);
-- Only the domain-separated FI digest is stored. Legacy bearer and quota stay unchanged.
CREATE TABLE public.fi_dns_meter_requests (
  request_id uuid PRIMARY KEY,
  entitlement_id uuid REFERENCES public.personal_dns_credentials(entitlement_id) ON DELETE RESTRICT,
  token_sha256 text CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
  credential_revision bigint,
  reservation_expires_at timestamptz,
  state text NOT NULL CHECK(state IN ('RESERVED','SETTLED','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((entitlement_id IS NOT NULL AND token_sha256 IS NOT NULL AND credential_revision IS NOT NULL AND reservation_expires_at IS NOT NULL)
    OR (entitlement_id IS NULL AND token_sha256 IS NULL AND credential_revision IS NULL AND reservation_expires_at IS NULL AND state='RELEASED'))
);
REVOKE ALL ON public.fi_dns_meter_gate,public.fi_dns_regional_credentials,public.fi_dns_meter_requests FROM PUBLIC;

-- Caller is the isolated controller, not the node itself, bot or website.
-- The caller must authenticate node identity before invoking this ABI.
-- Request lock first, then canonical entitlement lock (also used by legacy meter).
CREATE FUNCTION public.fi_dns_meter_apply(p_op text,p_request uuid,p_digest text DEFAULT NULL)
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
  -- Paid native-query pilot only; legacy byte plans, trials and restored
  -- refunded source orders require separate verified eligibility policy.
  v_active:=COALESCE(
    f.revoked_at IS NULL AND c.revoked_at IS NULL AND f.token_sha256 IS NOT NULL
    AND e.product='smart_dns' AND e.state='ACTIVE'
    AND e.starts_at<=v_now AND e.expires_at>v_now
    AND e.dns_query_quota_per_30d IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.orders o WHERE o.id=e.source_order_id
      AND o.account_id=e.account_id AND o.state='PAID')
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
      AND used_queries+reserved_queries<LEAST(c.query_limit_per_30d,e.dns_query_quota_per_30d);
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
REVOKE ALL ON FUNCTION public.fi_dns_meter_apply(text,uuid,text) FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_fi_dns_meter') THEN
    CREATE ROLE mnebyvpn_fi_dns_meter NOLOGIN NOINHERIT;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.fi_dns_meter_apply(text,uuid,text) TO mnebyvpn_fi_dns_meter;
COMMIT;
