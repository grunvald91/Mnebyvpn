-- Dedicated offline PostgreSQL schema migration; do not apply on live VPS.
-- One purchased package (entitlement_id) is one independent network credential.
-- Never recycle a personal bearer IPv6 address to a different package.
BEGIN;

ALTER TABLE provisioning_state
  ADD COLUMN external_ref text;
CREATE UNIQUE INDEX provisioning_external_ref_unique
  ON provisioning_state(adapter, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TABLE smart_dns_ipv6_claims (
  destination_ipv6 inet PRIMARY KEY,
  entitlement_id uuid NOT NULL UNIQUE REFERENCES entitlements(id) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CHECK (family(destination_ipv6) = 6 AND masklen(destination_ipv6) = 128)
);
CREATE INDEX smart_dns_ipv6_claims_active_idx
  ON smart_dns_ipv6_claims(entitlement_id) WHERE retired_at IS NULL;

-- Use a permanent row even after revoke/refund/expiry. DELETE is NEVER part
-- of the normal lifecycle; the address remains reserved for that package.
CREATE FUNCTION claim_smart_dns_ipv6(
  p_entitlement_id uuid, p_destination_ipv6 inet
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_entitlement entitlements%ROWTYPE;
  v_current smart_dns_ipv6_claims%ROWTYPE;
BEGIN
  IF p_entitlement_id IS NULL OR p_destination_ipv6 IS NULL
     OR family(p_destination_ipv6) <> 6 OR masklen(p_destination_ipv6) <> 128 THEN
    RETURN 'DENY_INVALID';
  END IF;
  SELECT * INTO v_entitlement FROM entitlements
    WHERE id=p_entitlement_id FOR UPDATE;
  IF NOT FOUND OR v_entitlement.product <> 'smart_dns' OR
     v_entitlement.state NOT IN ('PAID_PENDING_PROVISIONING','PROVISIONING_FAILED','ACTIVE') OR
     v_entitlement.expires_at IS NULL OR
     v_entitlement.expires_at <= clock_timestamp() THEN
    RETURN 'DENY_INACTIVE';
  END IF;

  SELECT * INTO v_current FROM smart_dns_ipv6_claims
    WHERE entitlement_id=p_entitlement_id;
  IF FOUND THEN
    RETURN CASE WHEN v_current.destination_ipv6=p_destination_ipv6 AND v_current.retired_at IS NULL
      THEN 'ALREADY_BOUND' ELSE 'DENY_ALREADY_CLAIMED' END;
  END IF;
  -- Primary key prevents ANY cross-package recycling, even if retired.
  INSERT INTO smart_dns_ipv6_claims(destination_ipv6, entitlement_id)
    VALUES(p_destination_ipv6, p_entitlement_id)
    ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 'DENY_ADDRESS_RESERVED'; END IF;
  RETURN 'BOUND';
END;
$$;

CREATE FUNCTION retire_smart_dns_ipv6(p_entitlement_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE smart_dns_ipv6_claims
    SET retired_at=COALESCE(retired_at, clock_timestamp())
    WHERE entitlement_id=p_entitlement_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION claim_smart_dns_ipv6(uuid,inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION retire_smart_dns_ipv6(uuid) FROM PUBLIC;
REVOKE ALL ON smart_dns_ipv6_claims FROM PUBLIC;
COMMIT;
