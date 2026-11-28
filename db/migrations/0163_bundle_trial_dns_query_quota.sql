-- Canonical 24h bundle trials share 30,000 mapped DNS answers across DE/FI.
-- Keep legacy standalone trials and paid credentials unchanged. No offer flags.
BEGIN;
CREATE OR REPLACE FUNCTION issue_personal_dns_credential(
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

  -- Both website and Telegram issuance use this function. Override the
  -- caller's default only for the new internal bundle trial.
  IF EXISTS(SELECT 1 FROM orders o WHERE o.id=e.source_order_id
     AND o.account_id=e.account_id AND o.state='TRIAL'
     AND o.provider='internal_trial' AND o.amount_minor=0 AND o.product='bundle') THEN
    IF NOT EXISTS(SELECT 1 FROM trial_grants g WHERE g.order_id=e.source_order_id
       AND g.account_id=e.account_id AND g.product='bundle'
       AND g.activated_at=e.starts_at AND g.access_expires_at=e.expires_at
       AND g.access_expires_at=g.activated_at+interval '24 hours') THEN
      RETURN 'DENY_INACTIVE';
    END IF;
    p_limit:=30000;
  END IF;
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
REVOKE ALL ON FUNCTION issue_personal_dns_credential(uuid,text,text,bigint) FROM PUBLIC;
COMMIT;
