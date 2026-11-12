-- MNEBYDNS personal, time-based access to encrypted DNS (NOT HTTPS byte-metering).
-- Offline rollout only. Existing billing/credits/provider integrations are not modified.
BEGIN;

CREATE TABLE dns_subscription_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id uuid NOT NULL REFERENCES entitlements(id) ON DELETE RESTRICT,
  token_sha256 text NOT NULL UNIQUE CHECK(token_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CHECK(revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE UNIQUE INDEX dns_subscription_one_live_link
  ON dns_subscription_links(entitlement_id) WHERE revoked_at IS NULL;
CREATE INDEX dns_subscription_by_entitlement
  ON dns_subscription_links(entitlement_id,created_at DESC);
REVOKE ALL ON dns_subscription_links FROM PUBLIC;

-- Aggregates only. NO DNS names, source addresses, query payloads or URL paths.
CREATE TABLE dns_subscription_daily_usage (
  link_id uuid NOT NULL REFERENCES dns_subscription_links(id) ON DELETE RESTRICT,
  utc_day date NOT NULL,
  authorized_queries bigint NOT NULL DEFAULT 0 CHECK(authorized_queries >= 0),
  last_query_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(link_id,utc_day)
);
REVOKE ALL ON dns_subscription_daily_usage FROM PUBLIC;

-- A real paid/verified order is required. Mere PENDING checkout or a
-- browser success redirect cannot create a working resolver credential.
CREATE FUNCTION dns_issue_link_for_account(
  p_account uuid,p_entitlement uuid,p_token_sha256 text,p_rotate boolean DEFAULT false
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $dns120$
DECLARE
  v_ent entitlements%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_account IS NULL OR p_entitlement IS NULL OR p_rotate IS NULL OR
     p_token_sha256 IS NULL OR p_token_sha256 !~ '^[a-f0-9]{64}$'
  THEN RETURN 'DENY_INVALID'; END IF;
  SELECT * INTO v_ent FROM entitlements
    WHERE id=p_entitlement AND account_id=p_account AND product='smart_dns'
    FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_ACCOUNT'; END IF;
  -- Calculate NOW *after* waiting for the row lock. A concurrent renewal
  -- or expiry may commit while we are blocked acquiring this lock.
  v_now:=clock_timestamp();
  IF v_ent.state<>'ACTIVE' OR v_ent.starts_at IS NULL
     OR v_ent.starts_at>v_now OR v_ent.expires_at IS NULL
     OR v_ent.expires_at<=v_now THEN RETURN 'DENY_INACTIVE'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM provisioning_state p
      WHERE p.entitlement_id=v_ent.id AND p.adapter='smart_dns'
        AND p.applied_revision=v_ent.revision
        AND p.last_observed_at IS NOT NULL
  ) THEN RETURN 'DENY_NOT_PROVISIONED'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM entitlement_credits c JOIN orders o ON o.id=c.order_id
      WHERE c.entitlement_id=v_ent.id AND c.refunded_at IS NULL
        AND o.state='PAID' AND c.starts_at<=v_now AND c.ends_at>v_now
  ) THEN RETURN 'DENY_NOT_PAID'; END IF;
  IF EXISTS(
    SELECT 1 FROM dns_subscription_links l
      WHERE l.entitlement_id=v_ent.id AND l.revoked_at IS NULL
  ) THEN
    IF NOT p_rotate THEN RETURN 'ALREADY_ISSUED'; END IF;
    UPDATE dns_subscription_links SET revoked_at=v_now
      WHERE entitlement_id=v_ent.id AND revoked_at IS NULL;
  END IF;
  INSERT INTO dns_subscription_links(entitlement_id,token_sha256)
    VALUES(v_ent.id,p_token_sha256);
  RETURN CASE WHEN p_rotate THEN 'ROTATED' ELSE 'ISSUED' END;
END;
$dns120$;
REVOKE ALL ON FUNCTION dns_issue_link_for_account(uuid,uuid,text,boolean) FROM PUBLIC;

-- Intentional manual revocation is permanent for this token, including if
-- customer later extends the subscription. Renewal of a still-live package
-- can reuse the existing DNS link (no monthly reinstallation).
CREATE FUNCTION dns_revoke_link_for_account(p_account uuid,p_entitlement uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $dns120$
DECLARE v_ent uuid;
BEGIN
  IF p_account IS NULL OR p_entitlement IS NULL THEN RETURN 'DENY_INVALID'; END IF;
  SELECT id INTO v_ent FROM entitlements
   WHERE id=p_entitlement AND account_id=p_account AND product='smart_dns'
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_ACCOUNT'; END IF;
  UPDATE dns_subscription_links SET revoked_at=clock_timestamp()
   WHERE entitlement_id=v_ent AND revoked_at IS NULL;
  IF FOUND THEN RETURN 'REVOKED'; END IF;
  RETURN 'ALREADY_REVOKED';
END;
$dns120$;
REVOKE ALL ON FUNCTION dns_revoke_link_for_account(uuid,uuid) FROM PUBLIC;

-- Refunds that remove all remaining paid credit result in REFUNDED/EXPIRED.
-- On terminal refund/cancellation, a previously shared link must NOT
-- reawaken automatically if another payment later renews the entitlement.
CREATE FUNCTION dns_revoke_terminal_entitlement_links()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp
AS $dns120$
BEGIN
  IF NEW.product='smart_dns' AND NEW.state IN ('REFUNDED','CANCELLED')
     AND (OLD.state IS DISTINCT FROM NEW.state) THEN
    UPDATE dns_subscription_links SET revoked_at=clock_timestamp()
      WHERE entitlement_id=NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$dns120$;
CREATE TRIGGER dns_terminal_entitlement_link_revoke
AFTER UPDATE OF state ON entitlements
FOR EACH ROW EXECUTE FUNCTION dns_revoke_terminal_entitlement_links();
REVOKE ALL ON FUNCTION dns_revoke_terminal_entitlement_links() FROM PUBLIC;

-- A DoT or DoH front end must derive the token from a verified TLS SNI
-- or an exact HTTPS path and pass only its SHA-256 hash to this procedure.
-- Count *authorised DNS wire messages*, not proxy HTTPS bytes or gigabytes.
CREATE FUNCTION dns_authorize_and_count_query(p_token_sha256 text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $dns120$
DECLARE
  v_link dns_subscription_links%ROWTYPE;
  v_ent entitlements%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_token_sha256 IS NULL OR
     p_token_sha256 !~ '^[a-f0-9]{64}$'
  THEN RETURN 'DENY_INVALID'; END IF;
  SELECT l.* INTO v_link FROM dns_subscription_links l
    WHERE l.token_sha256=p_token_sha256 AND l.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN 'DENY'; END IF;
  -- Entitlement lock serializes against refund, renewal and account revoke.
  SELECT * INTO v_ent FROM entitlements
    WHERE id=v_link.entitlement_id FOR UPDATE;
  -- Do not authorize an already expired credential when a refund or renewal
  -- transaction held the entitlement lock past the subscription deadline.
  v_now:=clock_timestamp();
  IF NOT FOUND OR v_ent.product<>'smart_dns'
     OR v_ent.state<>'ACTIVE' OR v_ent.starts_at IS NULL
     OR v_ent.starts_at>v_now OR v_ent.expires_at IS NULL
     OR v_ent.expires_at<=v_now THEN RETURN 'DENY'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM provisioning_state p
      WHERE p.entitlement_id=v_ent.id AND p.adapter='smart_dns'
        AND p.applied_revision=v_ent.revision
        AND p.last_observed_at IS NOT NULL
  ) THEN RETURN 'DENY'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM entitlement_credits c JOIN orders o ON o.id=c.order_id
      WHERE c.entitlement_id=v_ent.id AND c.refunded_at IS NULL
        AND o.state='PAID' AND c.starts_at<=v_now AND c.ends_at>v_now
  ) THEN RETURN 'DENY'; END IF;
  -- Repeat after the entitlement lock: a concurrent user revocation may
  -- have committed while this query was waiting for the lock.
  IF NOT EXISTS(
    SELECT 1 FROM dns_subscription_links l
      WHERE l.id=v_link.id AND l.revoked_at IS NULL
  ) THEN RETURN 'DENY'; END IF;
  INSERT INTO dns_subscription_daily_usage(link_id,utc_day,authorized_queries,last_query_at)
    VALUES(v_link.id,(v_now AT TIME ZONE 'UTC')::date,1,v_now)
    ON CONFLICT (link_id,utc_day)
    DO UPDATE SET authorized_queries=dns_subscription_daily_usage.authorized_queries+1,
      last_query_at=EXCLUDED.last_query_at;
  RETURN 'AUTHORIZED';
END;
$dns120$;
REVOKE ALL ON FUNCTION dns_authorize_and_count_query(text) FROM PUBLIC;

-- A public caller never chooses which account to view; the authenticated
-- website alone supplies the account derived from a verified DB session.
CREATE FUNCTION dns_links_for_account(p_account uuid)
RETURNS TABLE(
  entitlement_id uuid,access_state text,expires_at timestamptz,
  link_issued_at timestamptz,authorized_queries numeric,last_query_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $dns120$
  SELECT e.id,
    CASE WHEN e.state='ACTIVE' AND e.expires_at>clock_timestamp()
              AND l.id IS NOT NULL
              AND EXISTS(
                SELECT 1 FROM provisioning_state p
                  WHERE p.entitlement_id=e.id AND p.adapter='smart_dns'
                    AND p.applied_revision=e.revision
                    AND p.last_observed_at IS NOT NULL)
              AND EXISTS(
                SELECT 1 FROM entitlement_credits c JOIN orders o ON o.id=c.order_id
                  WHERE c.entitlement_id=e.id AND c.refunded_at IS NULL
                    AND o.state='PAID' AND c.starts_at<=clock_timestamp()
                    AND c.ends_at>clock_timestamp())
        THEN 'ACTIVE'
      WHEN l.id IS NOT NULL THEN 'INACTIVE'
      WHEN e.state='ACTIVE' AND e.expires_at>clock_timestamp()
        THEN 'NOT_ISSUED'
      ELSE 'INACTIVE'
    END::text,
    e.expires_at,
    l.created_at,
    COALESCE((SELECT sum(u.authorized_queries)::numeric
       FROM dns_subscription_daily_usage u WHERE u.link_id=l.id),0)::numeric,
    (SELECT max(u.last_query_at) FROM dns_subscription_daily_usage u
       WHERE u.link_id=l.id)
  FROM entitlements e
  LEFT JOIN dns_subscription_links l ON l.entitlement_id=e.id
    AND l.revoked_at IS NULL
  WHERE e.account_id=p_account AND e.product='smart_dns'
  ORDER BY e.expires_at DESC NULLS LAST,e.id;
$dns120$;
REVOKE ALL ON FUNCTION dns_links_for_account(uuid) FROM PUBLIC;

DO $dns120$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_dns_resolver') THEN
   CREATE ROLE mnebyvpn_dns_resolver NOLOGIN;
 END IF;
END;
$dns120$;
GRANT EXECUTE ON FUNCTION dns_authorize_and_count_query(text)
  TO mnebyvpn_dns_resolver;
DO $dns120$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnebyvpn_site_auth') THEN
   GRANT EXECUTE ON FUNCTION dns_issue_link_for_account(uuid,uuid,text,boolean)
     TO mnebyvpn_site_auth;
   GRANT EXECUTE ON FUNCTION dns_revoke_link_for_account(uuid,uuid)
     TO mnebyvpn_site_auth;
   GRANT EXECUTE ON FUNCTION dns_links_for_account(uuid)
     TO mnebyvpn_site_auth;
 END IF;
END;
$dns120$;
COMMIT;
