-- Personal DoT hostname identity and atomic per-subscription DNS query budget.
-- One accepted DNS message is one unit; this is NOT TCP connection count.
-- Only on test PostgreSQL until a verified DoT SNI-terminating gateway exists.
BEGIN;

CREATE TABLE personal_dns_credentials (
  entitlement_id uuid PRIMARY KEY REFERENCES entitlements(id) ON DELETE RESTRICT,
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  label text NOT NULL UNIQUE CHECK (label ~ '^d[a-z2-7]{26}$'),
  query_limit_per_30d bigint NOT NULL DEFAULT 1000000
    CHECK (query_limit_per_30d BETWEEN 1 AND 100000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);
REVOKE ALL ON personal_dns_credentials FROM PUBLIC;

CREATE TABLE personal_dns_query_windows (
  entitlement_id uuid NOT NULL REFERENCES personal_dns_credentials(entitlement_id)
    ON DELETE RESTRICT,
  period_index bigint NOT NULL CHECK(period_index >= 0),
  used_queries bigint NOT NULL DEFAULT 0 CHECK(used_queries >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (entitlement_id,period_index)
);
REVOKE ALL ON personal_dns_query_windows FROM PUBLIC;

-- Only trusted provisioning worker may call this function. Label is a
-- bearer capability delivered to the subscriber; store just its digest.
CREATE FUNCTION issue_personal_dns_credential(
  p_entitlement uuid,p_label text,p_token_hash text,p_limit bigint DEFAULT 1000000
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE e entitlements%ROWTYPE;
BEGIN
  IF p_entitlement IS NULL OR p_label IS NULL
     OR p_label !~ '^d[a-z2-7]{26}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000000
  THEN RETURN 'DENY_INVALID'; END IF;

  SELECT * INTO e FROM entitlements WHERE id=p_entitlement FOR UPDATE;
  IF NOT FOUND OR e.product <> 'smart_dns' OR e.state <> 'ACTIVE'
     OR e.starts_at IS NULL OR e.expires_at IS NULL
     OR e.starts_at > clock_timestamp() OR e.expires_at <= clock_timestamp()
  THEN RETURN 'DENY_INACTIVE'; END IF;

  IF EXISTS(SELECT 1 FROM personal_dns_credentials WHERE entitlement_id=p_entitlement)
  THEN RETURN 'ALREADY_ISSUED'; END IF;

  INSERT INTO personal_dns_credentials(
    entitlement_id,label,token_sha256,query_limit_per_30d
  ) VALUES(p_entitlement,p_label,p_token_hash,p_limit)
    ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 'DENY_TOKEN_COLLISION'; END IF;
  RETURN 'ISSUED';
END;
$$;

-- Run exactly once for each valid DNS message on an authenticated TLS
-- connection (including cached answers if returned by the gateway).
-- Lock entitlement before updating the counter; parallel sockets cannot
-- pass a shared limit or a simultaneously committed revoke/refund.
CREATE FUNCTION consume_personal_dns_query(p_label text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  e entitlements%ROWTYPE;
  c personal_dns_credentials%ROWTYPE;
  v_entitlement_id uuid;
  v_now timestamptz;
  v_index bigint;
  v_used bigint;
BEGIN
  IF p_label IS NULL OR p_label !~ '^d[a-z2-7]{26}$'
    THEN RETURN 'DENY_INVALID'; END IF;

  SELECT entitlement_id INTO v_entitlement_id
    FROM personal_dns_credentials WHERE label=p_label;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;

  SELECT * INTO e FROM entitlements WHERE id=v_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
  v_now := clock_timestamp();

  -- Read after entitlement lock to observe committed revoke/credential changes.
  SELECT * INTO c FROM personal_dns_credentials WHERE entitlement_id=e.id;
  IF NOT FOUND OR c.label <> p_label OR c.revoked_at IS NOT NULL
     OR e.product <> 'smart_dns' OR e.state <> 'ACTIVE'
     OR e.starts_at IS NULL OR e.expires_at IS NULL
     OR e.starts_at > v_now OR e.expires_at <= v_now
  THEN RETURN 'DENY_INACTIVE'; END IF;

  -- Exactly 30*24h per window anchored at paid entitlement.start. Paid
  -- renewal extends expiry but does NOT silently reset the active window.
  v_index := floor(extract(epoch from (v_now-e.starts_at))/2592000)::bigint;
  IF v_index < 0 THEN RETURN 'DENY_INACTIVE'; END IF;

  INSERT INTO personal_dns_query_windows(entitlement_id,period_index,used_queries)
    VALUES(e.id,v_index,0) ON CONFLICT DO NOTHING;
  UPDATE personal_dns_query_windows
    SET used_queries=used_queries+1,updated_at=v_now
    WHERE entitlement_id=e.id AND period_index=v_index
      AND used_queries < c.query_limit_per_30d
    RETURNING used_queries INTO v_used;
  IF NOT FOUND THEN RETURN 'DENY_QUOTA'; END IF;
  RETURN 'ALLOWED';
END;
$$;

CREATE FUNCTION revoke_personal_dns_credential(p_entitlement uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  e entitlements%ROWTYPE;
  count_updated integer;
BEGIN
  SELECT * INTO e FROM entitlements WHERE id=p_entitlement FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE personal_dns_credentials
    SET revoked_at=COALESCE(revoked_at,clock_timestamp())
    WHERE entitlement_id=p_entitlement;
  GET DIAGNOSTICS count_updated=ROW_COUNT;
  RETURN count_updated=1;
END;
$$;

-- For a trusted subscriber cabinet/bot worker only; the API MUST also
-- authenticate that the requester owns this entitlement. Never expose by
-- an arbitrary UUID from a public endpoint.
CREATE FUNCTION personal_dns_query_status(p_entitlement uuid)
RETURNS TABLE(
  dns_label text,
  access_status text,
  used_queries bigint,
  remaining_queries bigint,
  allowed_queries bigint,
  next_reset_at timestamptz,
  access_expires_at timestamptz
) LANGUAGE sql STABLE AS $$
  SELECT c.label,
    CASE
      WHEN c.revoked_at IS NOT NULL THEN 'REVOKED'
      WHEN e.state <> 'ACTIVE' OR e.expires_at IS NULL OR
           e.expires_at<=now() OR e.starts_at IS NULL OR e.starts_at>now()
        THEN 'INACTIVE'
      WHEN COALESCE(w.used_queries,0)>=c.query_limit_per_30d THEN 'QUOTA_EXHAUSTED'
      ELSE 'ACTIVE'
    END,
    COALESCE(w.used_queries,0),
    GREATEST(0::bigint,c.query_limit_per_30d-COALESCE(w.used_queries,0)),
    c.query_limit_per_30d,
    e.starts_at +
      make_interval(secs => ((GREATEST(0::bigint,floor(
        extract(epoch FROM(now()-e.starts_at))/2592000)::bigint)+1)*2592000)::double precision),
    e.expires_at
  FROM personal_dns_credentials c
  JOIN entitlements e ON e.id=c.entitlement_id
  LEFT JOIN personal_dns_query_windows w
    ON w.entitlement_id=e.id
   AND w.period_index=GREATEST(0::bigint,floor(
        extract(epoch FROM(now()-e.starts_at))/2592000)::bigint)
  WHERE e.id=p_entitlement
$$;

REVOKE ALL ON FUNCTION issue_personal_dns_credential(uuid,text,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_personal_dns_query(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_personal_dns_credential(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION personal_dns_query_status(uuid) FROM PUBLIC;
COMMIT;
