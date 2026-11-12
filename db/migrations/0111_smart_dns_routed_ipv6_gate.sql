-- Paid SmartDNS IPv6: permanent bearer tombstones + verified routed /64 gate.
-- OFFLINE migration. Never apply to the foreign VPS automatically.
-- Do not let an operator assign documentation/ULA/unrouted IPv6 to customers.
BEGIN;

CREATE TABLE smart_dns_routed_prefixes (
  network inet PRIMARY KEY,
  approved_for_existing_foreign_vps boolean NOT NULL DEFAULT false,
  provider_confirmed_at timestamptz,
  public_reachability_verified_at timestamptz,
  disabled_at timestamptz,
  CHECK (family(network) = 6 AND masklen(network) = 64),
  CHECK (network <<= '2000::/3'::inet),
  CHECK (NOT (network <<= '2001:db8::/32'::inet)),
  CHECK (network = network(network))
);
REVOKE ALL ON smart_dns_routed_prefixes FROM PUBLIC;

CREATE FUNCTION protect_smart_dns_ipv6_claims()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'SmartDNS destination IPv6 claims are permanent';
  END IF;
  IF NEW.destination_ipv6 IS DISTINCT FROM OLD.destination_ipv6
     OR NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR (NEW.retired_at IS DISTINCT FROM OLD.retired_at AND
         (OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL)) THEN
    RAISE EXCEPTION 'SmartDNS destination IPv6 claim cannot be rebound or revived';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER smart_dns_ipv6_immutable
  BEFORE UPDATE OR DELETE ON smart_dns_ipv6_claims
  FOR EACH ROW EXECUTE FUNCTION protect_smart_dns_ipv6_claims();
CREATE TRIGGER smart_dns_ipv6_notruncate
  BEFORE TRUNCATE ON smart_dns_ipv6_claims
  FOR EACH STATEMENT EXECUTE FUNCTION protect_smart_dns_ipv6_claims();

-- Preserve existing serializable-style per-entitlement row locking and
-- unique destination address claim. Add a mandatory verified prefix gate.
CREATE OR REPLACE FUNCTION claim_smart_dns_ipv6(
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

  -- Do not trust the number of kernel IPv6 addresses, an unverified /64 in
  -- a config file, or a synthetic GitHub runner successful unit test.
  IF NOT EXISTS (
      SELECT 1 FROM smart_dns_routed_prefixes AS rp
      WHERE p_destination_ipv6 <<= rp.network
        AND rp.approved_for_existing_foreign_vps IS TRUE
        AND rp.provider_confirmed_at IS NOT NULL
        AND rp.public_reachability_verified_at IS NOT NULL
        AND rp.disabled_at IS NULL
  ) THEN RETURN 'DENY_PREFIX_NOT_VERIFIED'; END IF;

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
  INSERT INTO smart_dns_ipv6_claims(destination_ipv6, entitlement_id)
    VALUES(p_destination_ipv6, p_entitlement_id)
    ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 'DENY_ADDRESS_RESERVED'; END IF;
  RETURN 'BOUND';
END;
$$;

REVOKE ALL ON FUNCTION claim_smart_dns_ipv6(uuid,inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_smart_dns_ipv6_claims() FROM PUBLIC;
COMMIT;
