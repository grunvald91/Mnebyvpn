-- Issue #84, stage 1: an OFFLINE admission contract for personal paid
-- Smart DNS ingress. This migration does NOT connect CoreDNS/nginx or deploy
-- anything. Never infer on-wire enforcement from a positive SQL response.
BEGIN;

-- A retired destination IPv6 is a permanent tombstone: it may not be deleted,
-- reused, mutated into another address, or revived. Normal retirement in 0003
-- remains valid and idempotent.
CREATE FUNCTION guard_smart_dns_ipv6_claim_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Smart DNS bearer IPv6 claims cannot be deleted'
      USING ERRCODE='23514';
  END IF;
  IF OLD.destination_ipv6 IS DISTINCT FROM NEW.destination_ipv6
     OR OLD.entitlement_id IS DISTINCT FROM NEW.entitlement_id
     OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
     OR (OLD.retired_at IS NOT NULL
         AND OLD.retired_at IS DISTINCT FROM NEW.retired_at) THEN
    RAISE EXCEPTION 'Smart DNS bearer IPv6 claim is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER smart_dns_ipv6_claim_no_reassignment
  BEFORE UPDATE OR DELETE ON smart_dns_ipv6_claims
  FOR EACH ROW EXECUTE FUNCTION guard_smart_dns_ipv6_claim_mutation();

-- ONLY an admission predicate. The real ingress must separately check
-- allowed SNI, reserve/settle the transferred bytes before forwarding and
-- enforce expiry/revoke on ALREADY OPEN connections. This query is not a
-- network authentication mechanism by itself.
--
-- A paid credit may come from an initial DNS/bundle purchase or a paid
-- renewal, even if the original source order was subsequently refunded.
-- Unverified trials are intentionally outside this paid-only gate.
CREATE FUNCTION authorize_paid_smart_dns_ingress(p_destination_ipv6 inet)
RETURNS TABLE (
  entitlement_id uuid,
  entitlement_revision bigint,
  expires_at timestamptz,
  remaining_bytes bigint
) LANGUAGE sql VOLATILE SECURITY INVOKER AS $$
  SELECT e.id, e.revision, e.expires_at,
         e.quota_limit_bytes - e.quota_used_bytes
    FROM smart_dns_ipv6_claims AS c
    JOIN entitlements AS e ON e.id = c.entitlement_id
    JOIN provisioning_state AS p ON p.entitlement_id = e.id
                                AND p.adapter = 'smart_dns'
   WHERE p_destination_ipv6 IS NOT NULL
     AND family(p_destination_ipv6) = 6
     AND masklen(p_destination_ipv6) = 128
     AND c.destination_ipv6 = p_destination_ipv6
     AND c.retired_at IS NULL
     AND e.product = 'smart_dns'
     AND e.state = 'ACTIVE'
     AND e.starts_at IS NOT NULL
     AND e.starts_at <= clock_timestamp()
     AND e.expires_at IS NOT NULL
     AND e.expires_at > clock_timestamp()
     AND e.quota_state = 'AVAILABLE'
     AND e.quota_limit_bytes IS NOT NULL
     AND e.quota_used_bytes < e.quota_limit_bytes
     -- No admission before final observed provisioning for this exact
     -- revision, or after a newer revoke/exhaustion/renewal revision.
     AND p.applied_revision = e.revision
     AND p.last_observed_at IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM entitlement_credits AS credit
         JOIN orders AS paid_order ON paid_order.id = credit.order_id
        WHERE credit.entitlement_id = e.id
          AND credit.refunded_at IS NULL
          AND credit.quota_bytes IS NOT NULL
          AND credit.consumed_bytes < credit.quota_bytes
          AND paid_order.state = 'PAID'
     )
   LIMIT 1;
$$;

-- No untrusted SQL client, website user or public resolver may call this
-- predicate by default. A future dedicated ingress role requires explicit
-- narrow grants, verified credentials and a reviewed deployment.
REVOKE ALL ON FUNCTION guard_smart_dns_ipv6_claim_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION authorize_paid_smart_dns_ingress(inet) FROM PUBLIC;
COMMIT;
