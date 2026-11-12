-- Personal DoT hostname identity and atomic per-subscription DNS query budget.
-- One accepted DNS message is one unit; this is NOT TCP connection count.
-- Only on test PostgreSQL until a verified DoT SNI-terminating gateway exists.
BEGIN;

CREATE TABLE personal_dns_credentials (
  entitlement_id uuid PRIMARY KEY REFERENCES entitlements(id) ON DELETE RESTRICT,
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  credential_revision bigint NOT NULL DEFAULT 1 CHECK (credential_revision >= 1),
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
-- bearer capability delivered once to the subscriber; store only its digest.
CREATE FUNCTION issue_personal_dns_credential(
  p_entitlement uuid,p_label text,p_token_hash text,p_limit bigint DEFAULT 1000000
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  e entitlements%ROWTYPE;
  existing personal_dns_credentials%ROWTYPE;
BEGIN
  IF p_entitlement IS NULL OR p_label IS NULL
     OR p_label !~ '^[a-z0-9]{12}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$'
     OR p_token_hash <> encode(sha256(convert_to(p_label,'UTF8')),'hex')
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000000
  THEN RETURN 'DENY_INVALID'; END IF;

  SELECT * INTO e FROM entitlements WHERE id=p_entitlement FOR UPDATE;
  IF NOT FOUND OR e.product <> 'smart_dns' OR e.state <> 'ACTIVE'
     OR e.starts_at IS NULL OR e.expires_at IS NULL
     OR e.starts_at > clock_timestamp() OR e.expires_at <= clock_timestamp()
  THEN RETURN 'DENY_INACTIVE'; END IF;

  SELECT * INTO existing FROM personal_dns_credentials
    WHERE entitlement_id=p_entitlement;
  IF FOUND THEN
    IF existing.revoked_at IS NOT NULL THEN RETURN 'DENY_REVOKED'; END IF;
    IF existing.token_sha256=p_token_hash
       AND existing.query_limit_per_30d=p_limit
    THEN RETURN 'ALREADY_ISSUED'; END IF;
    RETURN 'DENY_ALREADY_ASSIGNED';
  END IF;

  INSERT INTO personal_dns_credentials(
    entitlement_id,token_sha256,query_limit_per_30d
  ) VALUES(p_entitlement,p_token_hash,p_limit)
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
  IF p_label IS NULL OR p_label !~ '^[a-z0-9]{12}$'
    THEN RETURN 'DENY_INVALID'; END IF;

  SELECT entitlement_id INTO v_entitlement_id
    FROM personal_dns_credentials
    WHERE token_sha256=encode(sha256(convert_to(p_label,'UTF8')),'hex');
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;

  SELECT * INTO e FROM entitlements WHERE id=v_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
  v_now := clock_timestamp();

  -- Read after entitlement lock to observe committed revoke/credential changes.
  SELECT * INTO c FROM personal_dns_credentials WHERE entitlement_id=e.id;
  IF NOT FOUND OR c.token_sha256 <>
      encode(sha256(convert_to(p_label,'UTF8')),'hex') OR c.revoked_at IS NOT NULL
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

-- Replace an exposed/lost DNS hostname without resetting quota.
-- Call only after verified owner authentication + current revision check.
CREATE FUNCTION rotate_personal_dns_credential(
  p_account uuid,p_entitlement uuid,p_expected_revision bigint,p_new_label text,p_new_token_hash text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  e entitlements%ROWTYPE;
  c personal_dns_credentials%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_account IS NULL OR p_entitlement IS NULL OR p_expected_revision IS NULL OR
     p_expected_revision < 1 OR p_new_label IS NULL OR
     p_new_label !~ '^[a-z0-9]{12}$' OR p_new_token_hash IS NULL OR
     p_new_token_hash !~ '^[a-f0-9]{64}$' OR
     p_new_token_hash <> encode(sha256(convert_to(p_new_label,'UTF8')),'hex')
  THEN RETURN 'DENY_INVALID'; END IF;
  SELECT * INTO e FROM entitlements WHERE id=p_entitlement FOR UPDATE;
  v_now:=clock_timestamp();
  IF NOT FOUND OR e.account_id<>p_account OR e.product<>'smart_dns' OR e.state<>'ACTIVE' OR
     e.starts_at IS NULL OR e.expires_at IS NULL OR
     e.starts_at>v_now OR e.expires_at<=v_now
  THEN RETURN 'DENY_INACTIVE'; END IF;
  SELECT * INTO c FROM personal_dns_credentials WHERE entitlement_id=p_entitlement;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN'; END IF;
  IF c.revoked_at IS NOT NULL THEN RETURN 'DENY_REVOKED'; END IF;
  IF c.credential_revision<>p_expected_revision THEN RETURN 'DENY_STALE'; END IF;
  IF c.token_sha256=p_new_token_hash THEN RETURN 'DENY_SAME'; END IF;
  BEGIN
    UPDATE personal_dns_credentials SET token_sha256=p_new_token_hash,
      credential_revision=credential_revision+1
      WHERE entitlement_id=p_entitlement;
  EXCEPTION WHEN unique_violation THEN
    RETURN 'DENY_TOKEN_COLLISION';
  END;
  RETURN 'ROTATED';
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
  credential_revision bigint,
  access_status text,
  used_queries bigint,
  remaining_queries bigint,
  allowed_queries bigint,
  next_reset_at timestamptz,
  access_expires_at timestamptz
) LANGUAGE sql STABLE AS $$
  SELECT c.credential_revision,CASE
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
REVOKE ALL ON FUNCTION rotate_personal_dns_credential(uuid,uuid,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION personal_dns_query_status(uuid) FROM PUBLIC;
COMMIT;
