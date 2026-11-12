-- Personal DNS credential + per-purchased-period quota: DNS LOOKUPS, not TCP
-- connections, streamed gigabytes, video views, or per-device identifiers.
-- Infrastructure gateway integration is a separate task: this migration
-- adds only atomic, testable state to the canonical billing database.
BEGIN;

CREATE TABLE personal_dns_links (
  entitlement_id uuid PRIMARY KEY REFERENCES entitlements(id) ON DELETE RESTRICT,
  token_digest text NOT NULL UNIQUE CHECK(token_digest ~ '^[0-9a-f]{64}$'),
  credential_revision integer NOT NULL DEFAULT 1 CHECK(credential_revision>0),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz
);
CREATE INDEX personal_dns_links_active_idx ON personal_dns_links(token_digest)
  WHERE disabled_at IS NULL;
REVOKE ALL ON personal_dns_links FROM PUBLIC;

CREATE TABLE personal_dns_query_usage (
  entitlement_id uuid PRIMARY KEY REFERENCES entitlements(id) ON DELETE RESTRICT,
  used_queries bigint NOT NULL DEFAULT 0 CHECK(used_queries>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON personal_dns_query_usage FROM PUBLIC;

-- Trusted issuer only. The HMAC secret and raw personal link MUST remain
-- outside SQL, logs and Git. To recover links, derive them from the same
-- owner-protected key, entitlement ID and stored credential_revision.
CREATE FUNCTION issue_personal_dns_link(
  p_entitlement_id uuid, p_token_digest text, p_revision integer
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  e entitlements%ROWTYPE;
  link personal_dns_links%ROWTYPE;
BEGIN
  IF p_entitlement_id IS NULL OR p_token_digest IS NULL OR
     p_token_digest !~ '^[0-9a-f]{64}$' OR p_revision IS NULL OR
     p_revision<=0 THEN RETURN 'DENY_INVALID'; END IF;
  SELECT * INTO e FROM entitlements WHERE id=p_entitlement_id FOR UPDATE;
  IF NOT FOUND OR e.product<>'smart_dns' OR
     e.state NOT IN ('ACTIVE','PAID_PENDING_PROVISIONING') OR
     e.expires_at IS NULL OR e.expires_at<=clock_timestamp()
  THEN RETURN 'DENY_INACTIVE'; END IF;

  IF NOT EXISTS(
    SELECT 1 FROM entitlement_credits c JOIN orders o ON o.id=c.order_id
    WHERE c.entitlement_id=e.id AND c.refunded_at IS NULL
      AND c.quota_bytes IS NOT NULL AND o.state='PAID'
  ) THEN RETURN 'DENY_NO_PAID_CREDIT'; END IF;

  SELECT * INTO link FROM personal_dns_links WHERE entitlement_id=e.id;
  IF FOUND THEN
    RETURN CASE
      WHEN link.disabled_at IS NULL AND link.token_digest=p_token_digest
         AND link.credential_revision=p_revision THEN 'ALREADY_ISSUED'
      ELSE 'DENY_DIFFERENT_CREDENTIAL'
    END;
  END IF;
  INSERT INTO personal_dns_links(entitlement_id,token_digest,credential_revision)
    VALUES(e.id,p_token_digest,p_revision) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 'DENY_CREDENTIAL_COLLISION'; END IF;
  INSERT INTO personal_dns_query_usage(entitlement_id) VALUES(e.id)
    ON CONFLICT DO NOTHING;
  RETURN 'ISSUED';
END;
$$;

-- Check link existence without consuming any quota unit. Ordinary
-- lookups must keep working, including when selected proxy quota runs out.
CREATE FUNCTION check_personal_dns_link(p_token_digest text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN 'DENY_UNKNOWN_LINK';
  END IF;
  RETURN CASE WHEN EXISTS(
    SELECT 1 FROM personal_dns_links
    WHERE token_digest=p_token_digest AND disabled_at IS NULL
  ) THEN 'KNOWN_LINK' ELSE 'DENY_UNKNOWN_LINK' END;
END;
$$;

-- One renewal of an existing entitlement adds one more 1M-query allowance,
-- preserving the *same* personal link. Payment credits that have been
-- refunded DO NOT count. Existing time-based expiry is still authoritative.
--
-- IMPORTANT: call only for a matching exact A record that the deployed
-- SmartDNS policy would actually rewrite and only after a successful
-- upstream response. Ordinary/direct domains must be resolved normally
-- without calling this debit function.
CREATE FUNCTION use_personal_dns_proxy_query(p_token_digest text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  id uuid;
  e entitlements%ROWTYPE;
  paid_credits bigint;
  current_usage bigint;
  max_queries bigint;
BEGIN
  IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN 'DENY_UNKNOWN_LINK';
  END IF;
  SELECT entitlement_id INTO id FROM personal_dns_links
    WHERE token_digest=p_token_digest AND disabled_at IS NULL;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN_LINK'; END IF;

  -- Share the canonical entitlement row lock with payment/refund/renewal
  -- operations and serialize simultaneous DNS requests for this buyer.
  SELECT * INTO e FROM entitlements WHERE entitlements.id=id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'DENY_UNKNOWN_LINK'; END IF;

  -- Recheck token while holding entitlement lock to close rotation races.
  IF NOT EXISTS(SELECT 1 FROM personal_dns_links WHERE entitlement_id=id
      AND token_digest=p_token_digest AND disabled_at IS NULL) THEN
    RETURN 'DENY_UNKNOWN_LINK';
  END IF;
  IF e.product<>'smart_dns' OR e.state<>'ACTIVE' OR
     e.expires_at IS NULL OR e.expires_at<=clock_timestamp() THEN
    RETURN 'DIRECT_INACTIVE';
  END IF;
  SELECT count(*) INTO paid_credits
  FROM entitlement_credits c JOIN orders o ON o.id=c.order_id
  WHERE c.entitlement_id=id AND o.state='PAID' AND
        c.refunded_at IS NULL AND c.quota_bytes IS NOT NULL;
  -- Don't count provider or app retries as another paid month. A credit is
  -- an immutable verified purchase/renewal, keyed by order_id in the ledger.
  max_queries := paid_credits*1000000;
  IF max_queries<=0 THEN RETURN 'DIRECT_NO_PAID_CREDIT'; END IF;

  INSERT INTO personal_dns_query_usage(entitlement_id)
    VALUES(id) ON CONFLICT DO NOTHING;
  SELECT used_queries INTO current_usage
    FROM personal_dns_query_usage WHERE entitlement_id=id FOR UPDATE;
  IF current_usage>=max_queries THEN RETURN 'DIRECT_QUOTA_EXHAUSTED'; END IF;
  UPDATE personal_dns_query_usage
    SET used_queries=used_queries+1,updated_at=clock_timestamp()
    WHERE entitlement_id=id;
  RETURN 'PROXY_ALLOWED';
END;
$$;

-- The same credential should continue to resolve ordinary domains without
-- charging even when the proxy-specific quota is exhausted. This function
-- does NOT authorize a TLS session to the shared IPv4 SNI passthrough.
CREATE FUNCTION personal_dns_query_balance(p_entitlement_id uuid)
RETURNS TABLE(used_queries bigint,paid_query_limit bigint,remaining_queries bigint,
              subscription_expires_at timestamptz,entitlement_state text)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT COALESCE(u.used_queries,0)::bigint,
         (count(c.order_id)*1000000)::bigint,
         GREATEST(0,count(c.order_id)*1000000-COALESCE(u.used_queries,0))::bigint,
         e.expires_at,e.state
  FROM entitlements e
  LEFT JOIN personal_dns_query_usage u ON u.entitlement_id=e.id
  LEFT JOIN entitlement_credits c ON c.entitlement_id=e.id
    AND c.refunded_at IS NULL AND c.quota_bytes IS NOT NULL
    AND EXISTS(SELECT 1 FROM orders o WHERE o.id=c.order_id AND o.state='PAID')
  WHERE e.id=p_entitlement_id AND e.product='smart_dns'
  GROUP BY e.id,e.expires_at,e.state,u.used_queries;
END;
$$;

REVOKE ALL ON FUNCTION issue_personal_dns_link(uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION use_personal_dns_proxy_query(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION check_personal_dns_link(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION personal_dns_query_balance(uuid) FROM PUBLIC;
COMMIT;
